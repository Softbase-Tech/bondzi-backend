import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
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
import {
  AI_EMBEDDING_CLIENT,
  AI_GENERATION_CLIENT,
} from './clients/ai-generation.factory';
import { BedrockClient } from './clients/bedrock.client';
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
  /**
   * Why generation stopped — `max_tokens` means the output was
   * TRUNCATED and must not be validated as if complete (remediation
   * 0.4). `null` when the provider didn't report.
   */
  stopReason: string | null;
}

/**
 * Actions whose prompts carry per-student data (weakness rollups,
 * exam answers, personalised reviews). DPA policy: these NEVER route
 * to the self-hosted provider — they pin to Bedrock regardless of
 * AI_PROVIDER. Previously this policy existed only in comments
 * (ollama.client.ts / ai-generation.factory.ts) with no enforcement;
 * `callBedrock` now enforces it in code (remediation C-zero #3).
 */
const STUDENT_DATA_ACTIONS: ReadonlySet<AiAction> = new Set([
  AiAction.WEAKNESS_NARRATIVE,
  AiAction.AI_REVIEW,
  AiAction.POST_EXAM_BREAKDOWN,
  AiAction.CHAT_TUTOR,
]);

/**
 * Per-action sampling temperature (remediation 1.4). Question
 * generation wants diversity (exemplars are randomized precisely to
 * avoid output collapse — a low temperature works against that);
 * explanations and verification want determinism (fewer arithmetic
 * slips). Callers can override via opts.temperature.
 */
const TEMPERATURE_BY_ACTION: Partial<Record<AiAction, number>> = {
  [AiAction.QUESTION_GEN]: 0.8,
  [AiAction.EXPLANATION]: 0.15,
  [AiAction.MODERATION]: 0,
  [AiAction.ANSWER_VERIFY]: 0,
  [AiAction.WEAKNESS_NARRATIVE]: 0.4,
  [AiAction.AI_REVIEW]: 0.5,
  [AiAction.POST_EXAM_BREAKDOWN]: 0.4,
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    // Resolved by AiGenerationFactory: BedrockClient by default,
    // OllamaClient when AI_PROVIDER=self_hosted. Actions that carry
    // per-student data (STUDENT_DATA_ACTIONS) bypass this and route
    // to `bedrock` below — enforced in callBedrock, not by comment.
    @Inject(AI_GENERATION_CLIENT)
    private readonly ai: AiGenerationClient,
    // DPA pin target: student-data prompts must never reach a
    // self-hosted model, so those actions dispatch here directly.
    private readonly bedrock: BedrockClient,
    // Resolved independently by AiEmbeddingFactory (AI_EMBEDDING_PROVIDER,
    // falling back to AI_PROVIDER) so embeddings can run on a different
    // provider than generation.
    @Inject(AI_EMBEDDING_CLIENT)
    private readonly embedder: AiGenerationClient,
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

  /**
   * Refuse admin-triggered batches over the configured item cap.
   * Called by the admin AI generation controllers BEFORE the job is
   * enqueued — cheap 400 response, no LLM cost, no queue entry.
   *
   * Applies to both providers. On Bedrock the daily-budget guard
   * (`checkBudget` / `AI_MAX_JOB_COST_USD`) already keeps runaway
   * batches in check via $; on Ollama those are $0 and useless, so
   * a row-count ceiling is the only backstop against a mistyped
   * `count` writing tens of thousands of rows into prod.
   */
  assertBatchWithinCap(itemCount: number): void {
    const cap = this.config.get<number>('ai.maxItemsPerBatch') ?? 200;
    if (itemCount > cap) {
      throw new BadRequestException(
        `Batch of ${itemCount} items exceeds AI_MAX_ITEMS_PER_BATCH (${cap}). Split the request or raise the cap.`,
      );
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
      /** Override the per-action default temperature. */
      temperature?: number;
      /** Assistant prefill — see AiInvokeParams.prefill. */
      prefill?: string;
      /** Bedrock prompt-cache the system shell — see AiInvokeParams. */
      cacheSystemPrompt?: boolean;
      /** Recorded on ai_usage_log.prompt_version. */
      promptVersion?: string;
    } = {},
  ): Promise<AiCallResult> {
    const action = opts.action ?? AiAction.EXPLANATION;

    // Budget guard (remediation C-zero #4): student-facing calls carry
    // a userId and were previously bounded only by entitlement caps —
    // the per-user daily call limit and the global daily USD ceiling
    // now apply to them too. Job-driven calls (no userId) keep their
    // existing job-level checkBudget call in the processor.
    if (opts.userId) {
      await this.checkBudget(opts.userId);
    }

    // DPA pin (remediation C-zero #3): per-student prompts never reach
    // the self-hosted provider, whatever AI_PROVIDER says.
    const client = STUDENT_DATA_ACTIONS.has(action) ? this.bedrock : this.ai;

    const start = Date.now();
    const res = await client.invoke({
      modelId: model,
      system: opts.system,
      userPrompt: prompt,
      maxTokens: opts.maxTokens ?? 600,
      temperature: opts.temperature ?? TEMPERATURE_BY_ACTION[action],
      prefill: opts.prefill,
      cacheSystemPrompt: opts.cacheSystemPrompt,
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

    // Derive provider from the effective-model tag. The factory
    // stamps `ollama:<name>` for local runs; everything else is
    // Bedrock. Storing this explicitly on the row (rather than
    // reparsing on every dashboard query) keeps the admin AI monitor
    // fast and lets a future rename of the tag convention not break
    // historical joins.
    const provider = res.effectiveModel.startsWith('ollama:')
      ? 'ollama'
      : 'bedrock';
    await this.logUsage({
      userId: opts.userId,
      jobId: opts.jobId,
      action,
      provider,
      model: res.effectiveModel,
      inputTokens,
      outputTokens,
      costUsd: cost,
      latencyMs,
      promptVersion: opts.promptVersion,
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
      stopReason: res.stopReason,
    };
  }

  /**
   * Embed texts for semantic retrieval (syllabus RAG). Routes through the
   * embedding client (AI_EMBEDDING_PROVIDER). Logs usage like a generation
   * call so the admin AI monitor sees embedding spend; embedding cost is
   * negligible vs generation, and $0 on the local Ollama path.
   *
   * The SAME model must be used at ingest time and query time — the caller
   * stores `model` alongside each vector so a mismatch is detectable.
   */
  async embed(
    texts: string[],
    opts: { model?: string; userId?: string; jobId?: string } = {},
  ): Promise<{ vectors: number[][]; model: string; dim: number }> {
    if (texts.length === 0) return { vectors: [], model: '', dim: 0 };

    const model =
      opts.model ??
      this.config.get<string>('ai.embeddingModel') ??
      'amazon.titan-embed-text-v2:0';

    const start = Date.now();
    const res = await this.embedder.embed({ texts, modelId: model });
    const latencyMs = Date.now() - start;

    const provider = res.effectiveModel.startsWith('ollama:')
      ? 'ollama'
      : 'bedrock';
    const cost = costUsd(res.effectiveModel, res.inputTokens, 0);
    await this.logUsage({
      userId: opts.userId,
      jobId: opts.jobId,
      action: AiAction.EMBEDDING,
      provider,
      model: res.effectiveModel,
      inputTokens: res.inputTokens,
      outputTokens: 0,
      costUsd: cost,
      latencyMs,
    });
    await this.addCostToDailyBudget(cost);

    return {
      vectors: res.vectors,
      model: res.effectiveModel,
      dim: res.vectors[0]?.length ?? 0,
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
    /**
     * `bedrock` (default) or `ollama`. Derived by the caller from
     * the effective model tag returned by the client, so this
     * column always agrees with `model` on the same row.
     */
    provider?: string;
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
        provider: args.provider ?? 'bedrock',
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
