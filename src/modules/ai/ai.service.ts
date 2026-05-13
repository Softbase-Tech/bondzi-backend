import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { Repository } from 'typeorm';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { PromptTemplate } from './entities/prompt-template.entity';
import { AiAction } from '../../common/types/enums';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import { costUsd, todayUtcDateKey } from './ai-cost.util';
import { AiBudgetExceededException } from './ai.exceptions';
import { sanitizeHtml } from '../../common/utils/sanitize.util';

/**
 * v2: AI primitives — Claude + OpenAI clients, prompt-template loader, cost
 * tracking, daily-budget guard. Consumed by the admin-triggered bulk
 * generation workers (admin-ai-gen). The v1 on-demand per-question flow is
 * gone: students no longer trigger AI calls.
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
  private claude: Anthropic | null = null;
  private openai: OpenAI | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    @InjectRepository(AiUsageLog)
    private readonly usageRepo: Repository<AiUsageLog>,
    @InjectRepository(PromptTemplate)
    private readonly promptsRepo: Repository<PromptTemplate>,
  ) {}

  private getClaude(): Anthropic {
    if (this.claude) return this.claude;
    const apiKey = this.config.get<string>('ai.anthropicApiKey') as string;
    this.claude = new Anthropic({ apiKey });
    return this.claude;
  }

  private getOpenAI(): OpenAI {
    if (this.openai) return this.openai;
    const apiKey = this.config.get<string>('ai.openaiApiKey') as string;
    this.openai = new OpenAI({ apiKey });
    return this.openai;
  }

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

  /** Call Claude with `prompt`, track cost + usage, return normalised result. */
  async callClaude(
    prompt: string,
    model: string,
    opts: {
      maxTokens?: number;
      action?: AiAction;
      userId?: string;
      jobId?: string;
    } = {},
  ): Promise<AiCallResult> {
    const start = Date.now();
    const res = await this.getClaude().messages.create({
      model,
      max_tokens: opts.maxTokens ?? 600,
      messages: [{ role: 'user', content: prompt }],
    });
    const latencyMs = Date.now() - start;

    const content = res.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n')
      .trim();

    const inputTokens = res.usage?.input_tokens ?? 0;
    const outputTokens = res.usage?.output_tokens ?? 0;
    const cost = costUsd(model, inputTokens, outputTokens);

    await this.logUsage({
      userId: opts.userId,
      jobId: opts.jobId,
      action: opts.action ?? AiAction.EXPLANATION,
      model,
      inputTokens,
      outputTokens,
      costUsd: cost,
      latencyMs,
    });
    await this.addCostToDailyBudget(cost);

    return {
      content,
      contentHtml: sanitizeHtml(this.markdownToHtml(content)),
      model,
      inputTokens,
      outputTokens,
      costUsd: cost,
      latencyMs,
    };
  }

  /** Call OpenAI (failover) with identical instrumentation. */
  async callOpenAI(
    prompt: string,
    model: string,
    opts: {
      maxTokens?: number;
      action?: AiAction;
      userId?: string;
      jobId?: string;
    } = {},
  ): Promise<AiCallResult> {
    const start = Date.now();
    const res = await this.getOpenAI().chat.completions.create({
      model,
      max_tokens: opts.maxTokens ?? 600,
      messages: [{ role: 'user', content: prompt }],
    });
    const latencyMs = Date.now() - start;

    const content = res.choices[0]?.message?.content?.trim() ?? '';
    const inputTokens = res.usage?.prompt_tokens ?? 0;
    const outputTokens = res.usage?.completion_tokens ?? 0;
    const cost = costUsd(model, inputTokens, outputTokens);

    await this.logUsage({
      userId: opts.userId,
      jobId: opts.jobId,
      action: opts.action ?? AiAction.EXPLANATION,
      model,
      inputTokens,
      outputTokens,
      costUsd: cost,
      latencyMs,
      failoverUsed: true,
    });
    await this.addCostToDailyBudget(cost);

    return {
      content,
      contentHtml: sanitizeHtml(this.markdownToHtml(content)),
      model,
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
