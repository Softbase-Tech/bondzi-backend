import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { PromptTemplate } from './entities/prompt-template.entity';
import { AiAction } from '../../common/types/enums';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { costUsd, todayUtcDateKey } from './ai-cost.util';
import { AiBudgetExceededException } from './ai.exceptions';
import { sanitizeHtml } from '../../common/utils/sanitize.util';
import { AI_GENERATION_CLIENT } from './clients/ai-generation.factory';
import type { AiGenerationClient } from './clients/ai-generation-client.interface';

/**
 * v2: AI primitives — Bedrock-hosted Claude client, prompt-template loader,
 * cost tracking, daily-budget guard. Consumed by the admin-triggered bulk
 * generation workers (admin-ai-gen). The v1 on-demand per-question flow is
 * gone: students never trigger AI calls in the hot path.
 *
 * Provider: AWS Bedrock (regional, IAM-based auth) — replaces the direct
 * Anthropic + OpenAI SDKs that earlier versions used. The body schema is
 * the same Messages API the Anthropic SDK exposed; only model IDs change
 * (`anthropic.claude-...-v1:0`) and auth comes from the Bedrock SDK chain.
 */

export interface AiCallResult {
  content: string;
  contentHtml: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    // Resolved by AiGenerationFactory: BedrockClient by default,
    // OllamaClient when AI_PROVIDER=self_hosted. Services that must
    // stay on Bedrock regardless (weakness narratives, post-exam
    // breakdowns) inject BedrockClient directly instead of going
    // through the AiService generic path.
    @Inject(AI_GENERATION_CLIENT)
    private readonly ai: AiGenerationClient,
    @InjectRepository(AiUsageLog)
    private readonly usageRepo: Repository<AiUsageLog>,
    @InjectRepository(PromptTemplate)
    private readonly promptsRepo: Repository<PromptTemplate>,
  ) {}

  /**
   * Daily-budget guard. Throws AiBudgetExceededException if either the per-user
   * daily call limit or the global daily USD spend is breached. Admin jobs
   * typically call without `userId` so they are checked only against the
   * global budget.
   */
  async checkBudget(userId?: string): Promise<void> {
    const dateKey = todayUtcDateKey();
    const dailyBudgetUsd = this.config.get<number>('ai.dailyBudgetUsd') ?? 50;
    const perUserCalls = this.config.get<number>('ai.perUserDailyLimit') ?? 50;

    const globalCostStr = await this.redis.get(CacheKeys.aiCostDay(dateKey));
    const globalCost = globalCostStr ? parseFloat(globalCostStr) : 0;
    if (globalCost >= dailyBudgetUsd) {
      throw new AiBudgetExceededException('global');
    }

    if (userId) {
      const calls = await this.redis.incr(
        CacheKeys.aiUserDailyCalls(userId, dateKey),
        24 * 60 * 60,
      );
      if (calls > perUserCalls) throw new AiBudgetExceededException('user');
    }
  }

  async getActivePrompt(name: string): Promise<PromptTemplate> {
    const template = await this.promptsRepo.findOne({
      where: { name, isActive: true },
    });
    if (!template) {
      throw new Error(
        `No active prompt template found for name='${name}' — run npm run seed:prompts`,
      );
    }
    return template;
  }

  /**
   * Send a generation prompt through whichever LLM provider the
   * factory picked at boot (Bedrock by default, Ollama when
   * `AI_PROVIDER=self_hosted`). Records usage + tracks daily-budget.
   *
   * The method name is historic (v1 was Bedrock-only). The client
   * underneath is provider-agnostic — see AiGenerationClient. The
   * `model` param is passed through to Bedrock verbatim and IGNORED
   * by Ollama (Ollama uses `OLLAMA_MODEL` env). The usage log records
   * the ACTUAL model that ran via `effectiveModel` (`ollama:<name>`
   * for the local provider), so the admin AI monitor never has a
   * "which model billed?" ambiguity.
   */
  async callBedrock(
    prompt: string,
    model: string,
    opts: {
      maxTokens?: number;
      action?: AiAction;
      userId?: string;
      jobId?: string;
      system?: string;
    } = {},
  ): Promise<AiCallResult> {
    const start = Date.now();
    const res = await this.ai.invoke({
      modelId: model,
      system: opts.system,
      userPrompt: prompt,
      maxTokens: opts.maxTokens ?? 600,
    });
    const latencyMs = Date.now() - start;

    const content = res.text;
    const inputTokens = res.inputTokens;
    const outputTokens = res.outputTokens;
    // For local (`ollama:*`) runs cost is definitionally $0 — no
    // Bedrock invoice for them. costUsd() returns 0 for anything
    // prefixed `ollama:` (see ai-cost.util); the daily-budget guard
    // therefore ignores local calls, which is correct: they don't
    // burn AWS spend. Bedrock calls bill normally.
    const cost = costUsd(res.effectiveModel, inputTokens, outputTokens);

    await this.logUsage({
      userId: opts.userId,
      jobId: opts.jobId,
      action: opts.action ?? AiAction.EXPLANATION,
      model: res.effectiveModel,
      inputTokens,
      outputTokens,
      costUsd: cost,
      latencyMs,
    });
    await this.addCostToDailyBudget(cost);

    return {
      content,
      contentHtml: sanitizeHtml(this.markdownToHtml(content)),
      model: res.effectiveModel,
      inputTokens,
      outputTokens,
      costUsd: cost,
      latencyMs,
    };
  }

  private markdownToHtml(md: string): string {
    // Minimal conversion — the client renders raw markdown; HTML is a
    // fallback for admin review screens.
    return md
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
      .join('\n');
  }

  private async logUsage(args: {
    userId?: string;
    questionId?: string;
    jobId?: string;
    action: AiAction;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    latencyMs?: number;
    cacheHit?: boolean;
    failoverUsed?: boolean;
    promptVersion?: string;
  }): Promise<void> {
    try {
      await this.usageRepo.insert({
        userId: args.userId ?? null,
        questionId: args.questionId ?? null,
        action: args.action,
        model: args.model,
        inputTokens: args.inputTokens ?? null,
        outputTokens: args.outputTokens ?? null,
        costUsd: args.costUsd !== undefined ? args.costUsd.toFixed(6) : null,
        latencyMs: args.latencyMs ?? null,
        cacheHit: args.cacheHit ?? false,
        failoverUsed: args.failoverUsed ?? false,
        promptVersion: args.promptVersion ?? null,
      });
    } catch (err) {
      this.logger.warn(`AiUsageLog insert failed: ${(err as Error).message}`);
    }
  }

  private async addCostToDailyBudget(cost: number): Promise<void> {
    if (cost <= 0) return;
    await this.redis.incrByFloat(
      CacheKeys.aiCostDay(todayUtcDateKey()),
      cost,
      48 * 60 * 60,
    );
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
