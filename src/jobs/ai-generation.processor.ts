import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { AiGenerationJob } from '../modules/admin-ai-gen/entities/ai-generation-job.entity';
import { Question } from '../modules/questions/entities/question.entity';
import { Option } from '../modules/questions/entities/option.entity';
import { Subject } from '../modules/subjects/entities/subject.entity';
import { PmTestQuestion } from '../modules/pm-test/entities/pm-test-question.entity';
import { PmTestOption } from '../modules/pm-test/entities/pm-test-option.entity';
import { SyllabusTopic } from '../modules/subjects/entities/syllabus-topic.entity';
import { AiService } from '../modules/ai/ai.service';
import { QUEUE_AI_GENERATION } from '../modules/ai/ai.queues';
import { NotificationsService } from '../modules/notifications/notifications.service';
import {
  buildQuestionGenerationPrompt,
  QUESTION_GENERATION_PROMPT_VERSION,
  type ExemplarForPrompt,
} from '../modules/ai/instruction-layer/question-generation.prompt';
import {
  buildExplanationPrompt,
  EXPLANATION_PROMPT_VERSION,
} from '../modules/ai/instruction-layer/explanation.prompt';
import { SyllabusRetrievalService } from '../modules/syllabus/syllabus-retrieval.service';
import { KnowledgeRetrievalService } from '../modules/syllabus/knowledge-retrieval.service';
import { PromptExemplarService } from '../modules/ai/prompt-exemplars.service';
import { PromptTemplateRuntimeService } from '../modules/ai/prompt-template-runtime.service';
import { isQuantitativeSubject } from '../common/utils/quantitative-subject.util';
import { looksLikeCalcQuestion } from '../common/utils/looks-like-calc.util';
import {
  shuffleOptions,
  validateQuestionBatchSalvage,
  type ParsedQuestion,
} from '../modules/ai/validation/question.validator';
import { validateExplanation } from '../modules/ai/validation/explanation.validator';
import { AnswerVerifierService } from '../modules/ai/verifiers/answer-verifier.service';
import { RejectLogService } from '../modules/ai/reject-log.service';
import {
  AiAction,
  AiJobStatus,
  AiJobType,
  Difficulty,
  ExamType,
  NotificationChannel,
  QuestionStatus,
} from '../common/types/enums';
import { sanitizeHtml } from '../common/utils/sanitize.util';
import { resolveModelId } from '../modules/admin-ai-gen/estimates.util';

interface GenerationJobData {
  jobId: string;
}

interface PmTestSelectionParams {
  formLevel: number;
  subjectId: string;
  syllabusTopicIds?: string[];
  questionCount: number;
  difficulty: { easy: number; medium: number; hard: number };
  mode: 'append' | 'replace';
}

interface PmTestParams {
  examType: ExamType;
  selections: PmTestSelectionParams[];
  model: 'claude-haiku' | 'claude-sonnet';
  includeExplanations: boolean;
  batchSize: number;
}

interface ExplanationBulkParams {
  dto: { model: 'claude-haiku' | 'claude-sonnet' };
  questionIds: string[];
  regenerate?: boolean;
}

function distributeByDifficulty(
  total: number,
  mix: { easy: number; medium: number; hard: number },
): Record<'easy' | 'medium' | 'hard', number> {
  const easy = Math.floor((mix.easy / 100) * total);
  const medium = Math.floor((mix.medium / 100) * total);
  const hard = Math.max(0, total - easy - medium);
  return { easy, medium, hard };
}

/**
 * Unified worker for admin-triggered AI generation. Discriminates by the
 * AiGenerationJob.job_type persisted record — BullMQ stays simple with a
 * single queue.
 */
@Processor(QUEUE_AI_GENERATION)
export class AiGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(AiGenerationProcessor.name);

  constructor(
    @InjectRepository(AiGenerationJob)
    private readonly jobsRepo: Repository<AiGenerationJob>,
    @InjectRepository(Question)
    private readonly questionsRepo: Repository<Question>,
    @InjectRepository(Option)
    private readonly optionsRepo: Repository<Option>,
    @InjectRepository(Subject)
    private readonly subjectsRepo: Repository<Subject>,
    @InjectRepository(PmTestQuestion)
    private readonly pmTestQRepo: Repository<PmTestQuestion>,
    @InjectRepository(PmTestOption)
    private readonly pmTestORepo: Repository<PmTestOption>,
    @InjectRepository(SyllabusTopic)
    private readonly syllabusRepo: Repository<SyllabusTopic>,
    private readonly ai: AiService,
    private readonly notifications: NotificationsService,
    private readonly rejectLog: RejectLogService,
    private readonly syllabusRetrieval: SyllabusRetrievalService,
    private readonly knowledge: KnowledgeRetrievalService,
    private readonly exemplars: PromptExemplarService,
    private readonly promptTemplates: PromptTemplateRuntimeService,
    private readonly answerVerifier: AnswerVerifierService,
  ) {
    super();
  }

  /**
   * Per-run cache of past-paper exemplars, keyed by
   * (subject, syllabus_topic, difficulty). Populated on first miss
   * per key inside a job so a 200-question generation doesn't hit
   * the DB 200×; scoped to a single job so consecutive batches
   * still get different exemplars (they'd be identical WITHIN a
   * key, but every key sees its own random-ordered pick).
   */
  private async fetchExemplars(args: {
    subjectId: string;
    syllabusTopicId: string | null;
    difficulty: 'easy' | 'medium' | 'hard';
    cache: Map<string, ExemplarForPrompt[]>;
  }): Promise<ExemplarForPrompt[]> {
    const key = `${args.subjectId}|${args.syllabusTopicId ?? 'null'}|${args.difficulty}`;
    const cached = args.cache.get(key);
    if (cached !== undefined) return cached;
    try {
      const rows = await this.exemplars.fetch({
        subjectId: args.subjectId,
        syllabusTopicId: args.syllabusTopicId,
        difficulty: args.difficulty as Difficulty,
        k: 3,
      });
      const mapped: ExemplarForPrompt[] = rows.map((r) => ({
        body: r.body,
        options: r.options,
        explanation: r.explanation,
        year: r.year,
        paper: r.paper,
        difficulty: r.difficulty,
      }));
      args.cache.set(key, mapped);
      return mapped;
    } catch (err) {
      this.logger.warn(
        `[exemplars] fetch failed for subject=${args.subjectId} topic=${args.syllabusTopicId ?? 'null'}: ${(err as Error).message}`,
      );
      args.cache.set(key, []);
      return [];
    }
  }

  /**
   * Grounds a generation batch on the NaCCA curriculum. Retrieves the
   * nearest approved + embedded indicators for the subject/form/topic and
   * formats them as a bullet list the model must ground on; the legacy
   * topic description (if any) is appended as supplementary notes.
   *
   * Best-effort by design: any embed/retrieval failure — or simply a
   * subject with nothing approved+embedded yet — falls back to the legacy
   * context alone, so this never regresses generation for un-ingested
   * subjects. Results are memoised per job via `cache` so the same
   * (subject, form, topic) doesn't re-embed once per batch.
   */
  private async groundContext(args: {
    subjectId: string;
    formLevel: number | null;
    topicTitle: string;
    legacyContext: string;
    cache: Map<string, string>;
  }): Promise<string> {
    const key = `${args.subjectId}|${args.formLevel ?? 'any'}|${args.topicTitle}`;
    const cached = args.cache.get(key);
    if (cached !== undefined) return cached;

    let grounded = args.legacyContext;
    try {
      const queryText = [args.topicTitle, args.legacyContext]
        .map((s) => s?.trim())
        .filter(Boolean)
        .join(' — ');
      // Prefer form-scoped indicators; if the subject has none approved for
      // this form, widen to any form so partially-ingested subjects still
      // ground on something rather than nothing.
      let hits = await this.syllabusRetrieval.retrieve({
        subjectId: args.subjectId,
        queryText,
        formLevel: args.formLevel,
        k: 6,
      });
      if (hits.length === 0 && args.formLevel != null) {
        hits = await this.syllabusRetrieval.retrieve({
          subjectId: args.subjectId,
          queryText,
          formLevel: null,
          k: 6,
        });
      }
      if (hits.length > 0) {
        const lines = hits.map((h) => {
          const dok = h.targetDokLevels?.length
            ? ` [DoK ${h.targetDokLevels.join(',')}]`
            : '';
          return `- ${h.statement}${dok}`;
        });
        // Remediation 0.2: scope, not source — the old "ground the
        // questions strictly on these" wording contradicted the system
        // shell and pushed the model into paraphrasing indicator prose
        // (which the meta-syllabus validator then rejected).
        const block = [
          'NaCCA syllabus indicators (these define the SCOPE this batch must cover — source your facts from subject knowledge; do not paraphrase the indicator wording):',
          ...lines,
        ].join('\n');
        grounded = args.legacyContext?.trim()
          ? `${block}\n\nTopic notes:\n${args.legacyContext.trim()}`
          : block;
      }
    } catch (err) {
      this.logger.warn(
        `syllabus grounding failed for ${args.subjectId}/${args.topicTitle}; using legacy context: ${(err as Error).message}`,
      );
    }
    args.cache.set(key, grounded);
    return grounded;
  }

  /**
   * Knowledge Layer retrieval for a generation batch (premium plan §4).
   * Returns the rendered `<data type="reference_material">` body, or ''
   * when the subject has no ingested learning material (fallback:
   * today's subject-knowledge grounding). `retrieval_empty` is recorded
   * once per (subject, topic) as an informational reject-log row so
   * coverage improvements are measurable — it is NOT a rejection.
   */
  private async fetchReferenceMaterial(args: {
    subjectId: string;
    formLevel: number | null;
    topicTitle: string;
    jobId: string;
    modelId: string;
    cache: Map<string, string>;
    hasChunksCache: Map<string, boolean>;
  }): Promise<string> {
    const key = `${args.subjectId}|${args.formLevel ?? 'any'}|${args.topicTitle}`;
    const cached = args.cache.get(key);
    if (cached !== undefined) return cached;

    let hasChunks = args.hasChunksCache.get(args.subjectId);
    if (hasChunks === undefined) {
      hasChunks = await this.knowledge
        .hasChunks(args.subjectId)
        .catch(() => false);
      args.hasChunksCache.set(args.subjectId, hasChunks);
    }
    if (!hasChunks) {
      args.cache.set(key, '');
      return '';
    }

    let rendered = '';
    try {
      const bundle = await this.knowledge.retrieveForGeneration({
        subjectId: args.subjectId,
        formLevel: args.formLevel,
        queryText: args.topicTitle,
      });
      if (bundle.empty) {
        await this.recordRejectSafely({
          jobId: args.jobId,
          action: 'question_generation',
          modelId: args.modelId,
          reason: 'retrieval_empty',
          detail: `no learning-material chunks matched subject=${args.subjectId} topic="${args.topicTitle}" — generated on fallback path`,
        });
      } else {
        rendered = this.knowledge.renderReferenceMaterial(bundle);
      }
    } catch (err) {
      this.logger.warn(
        `[knowledge] retrieval failed for ${args.subjectId}/"${args.topicTitle}": ${(err as Error).message}`,
      );
    }
    args.cache.set(key, rendered);
    return rendered;
  }

  /**
   * Grounding block for a single explanation, keyed off the question stem.
   * Returns `undefined` when the subject has nothing to ground on or any
   * retrieval error occurs — the caller then omits the syllabus context and
   * the model grounds on the stem alone (unchanged legacy behaviour).
   *
   * The caller gates this behind `hasEmbeddedIndicators` (cached per job) so
   * un-ingested subjects never reach here and pay no embed cost.
   */
  private async groundExplanation(
    subjectId: string,
    questionBody: string,
  ): Promise<string | undefined> {
    try {
      const hits = await this.syllabusRetrieval.retrieve({
        subjectId,
        queryText: questionBody,
        formLevel: null,
        k: 4,
      });
      if (hits.length === 0) return undefined;
      const lines = hits.map((h) => {
        const dok = h.targetDokLevels?.length
          ? ` [DoK ${h.targetDokLevels.join(',')}]`
          : '';
        return `- ${h.statement}${dok}`;
      });
      // Remediation 0.2: scope, not source (see groundContext above).
      return [
        'NaCCA syllabus indicators (the learning outcomes this question serves — scope only; source facts from subject knowledge, never quote the indicator wording):',
        ...lines,
      ].join('\n');
    } catch (err) {
      this.logger.warn(
        `explanation grounding failed for subject ${subjectId}: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /**
   * Best-effort reject-log write. Never propagates errors — losing one
   * log row is preferable to failing the parent generation loop over a
   * transient DB blip.
   */
  private async recordRejectSafely(input: {
    jobId: string;
    action: 'question_generation' | 'explanation';
    modelId: string;
    reason: string;
    detail?: string | null;
    rawOutput?: string | null;
  }): Promise<void> {
    const provider: 'bedrock' | 'ollama' = input.modelId.startsWith('ollama:')
      ? 'ollama'
      : 'bedrock';
    try {
      await this.rejectLog.record({
        jobId: input.jobId,
        action: input.action,
        provider,
        model: input.modelId,
        reason: input.reason,
        detail: input.detail ?? null,
        rawOutput: input.rawOutput ?? null,
      });
    } catch (err) {
      this.logger.warn(
        `[reject-log] write failed for job=${input.jobId} reason=${input.reason}: ${(err as Error).message}`,
      );
    }
  }

  async process(bullJob: Job<GenerationJobData>): Promise<void> {
    const record = await this.jobsRepo.findOne({
      where: { id: bullJob.data.jobId },
    });
    if (!record) {
      this.logger.warn(`job ${bullJob.data.jobId} no longer exists; skipping.`);
      return;
    }

    // CRITICAL #15: enforce the global daily-budget gate at job START.
    // checkBudget throws AiBudgetExceededException when daily AI spend
    // is over the cap. The previous shape never called this — the cap
    // was effectively cosmetic. Per-user limits don't apply to admin
    // jobs (no `userId`), so only the global $ ceiling is checked here.
    try {
      await this.ai.checkBudget();
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `[ai-job] daily budget exceeded; refusing job ${record.id}: ${message}`,
      );
      await this.jobsRepo.update(record.id, {
        status: AiJobStatus.FAILED,
        completedAt: new Date(),
        errorLog: `Daily AI budget exceeded — ${message}`,
      });
      await this.sendJobSummary(
        record.id,
        AiJobStatus.FAILED,
        'Daily AI budget exceeded',
      );
      return;
    }

    await this.jobsRepo.update(record.id, {
      status: AiJobStatus.RUNNING,
      startedAt: new Date(),
    });

    try {
      if (record.jobType === AiJobType.PM_TEST_GENERATION) {
        await this.runPmTestJob(record);
      } else if (record.jobType === AiJobType.EXPLANATION_BULK) {
        await this.runExplanationJob(record);
      } else {
        throw new Error(`Unknown job type: ${String(record.jobType)}`);
      }
      await this.jobsRepo.update(record.id, {
        status: AiJobStatus.COMPLETED,
        completedAt: new Date(),
      });
      await this.sendJobSummary(record.id, AiJobStatus.COMPLETED);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`job ${record.id} failed: ${message}`);
      await this.jobsRepo.update(record.id, {
        status: AiJobStatus.FAILED,
        completedAt: new Date(),
        errorLog: message,
      });
      await this.sendJobSummary(record.id, AiJobStatus.FAILED, message);
    }
  }

  /**
   * #16 — per-job runaway-cost circuit breaker. The estimate is based on
   * fixed 400/200 token guesses, but Sonnet math explanations regularly
   * run 600–900 output tokens, so actual cost can be 3–5× the estimate.
   * If the running total exceeds the estimate by `JOB_COST_CAP_MULTIPLIER`
   * we abort the job mid-flight instead of bleeding budget. The estimate
   * itself was already capped at AI_MAX_JOB_COST_USD at submit time
   * (see AdminExplanationsService.assertUnderMaxCost), so the absolute
   * ceiling here is `cap * multiplier`.
   */
  private static readonly JOB_COST_CAP_MULTIPLIER = 1.5;
  /**
   * Absolute floor for the ratio check. On tiny jobs (a single question costs
   * a fraction of a cent) natural per-question token variance trivially blows
   * past 1.5×, so the ratio is meaningless there — this breaker exists to stop
   * runaway *batches*, not to police pennies. Only enforce the ratio once the
   * running cost is a real amount.
   */
  private static readonly JOB_COST_CAP_MIN_USD = 0.1;
  private exceedsJobCostCap(
    record: AiGenerationJob,
    runningCost: number,
  ): boolean {
    const estimate = parseFloat(record.estimatedCostUsd ?? '0');
    if (!Number.isFinite(estimate) || estimate <= 0) return false;
    if (runningCost <= AiGenerationProcessor.JOB_COST_CAP_MIN_USD) return false;
    return (
      runningCost > estimate * AiGenerationProcessor.JOB_COST_CAP_MULTIPLIER
    );
  }

  /**
   * Spec §5.2 step 7: send the admin a notification with a summary when the
   * job finishes. Used on both success + failure so nobody has to poll.
   */
  private async sendJobSummary(
    jobId: string,
    status: AiJobStatus,
    errorMessage?: string,
  ): Promise<void> {
    const fresh = await this.jobsRepo.findOne({ where: { id: jobId } });
    if (!fresh) return;
    const kind =
      fresh.jobType === AiJobType.PM_TEST_GENERATION
        ? 'PM Test generation'
        : 'Bulk explanation generation';
    const title =
      status === AiJobStatus.COMPLETED ? `${kind} complete` : `${kind} failed`;
    const body =
      status === AiJobStatus.COMPLETED
        ? `Processed ${fresh.completedItems}/${fresh.totalItems ?? 0}, ${fresh.failedItems} failed, $${fresh.actualCostUsd ?? '0.00'} spent.`
        : `Job ${jobId} failed: ${errorMessage ?? 'unknown error'}.`;
    await this.notifications
      .send({
        userId: fresh.triggeredBy,
        channel: NotificationChannel.IN_APP,
        title,
        body,
        data: {
          type: 'ai_job_complete',
          jobId,
          jobType: fresh.jobType,
          status,
          completedItems: fresh.completedItems,
          failedItems: fresh.failedItems,
          totalItems: fresh.totalItems,
          actualCostUsd: fresh.actualCostUsd,
        },
      })
      .catch((err) =>
        this.logger.warn(
          `admin job-complete notification failed: ${(err as Error).message}`,
        ),
      );
  }

  // ---- PM Test generation ---------------------------------------------------

  private async runPmTestJob(record: AiGenerationJob): Promise<void> {
    const params = record.parameters as unknown as PmTestParams;
    const modelId = resolveModelId(params.model);
    let completed = 0;
    let failed = 0;
    let totalCost = 0;
    // Memoises syllabus grounding per (subject, form, topic) for the life of
    // this job so we embed each topic query once, not once per batch.
    const groundCache = new Map<string, string>();
    // Per-job cache of past-paper exemplars keyed by
    // (subject | syllabus_topic | difficulty). The first batch on a
    // key hits the DB; subsequent batches on the same key reuse the
    // same 3 stems. Different keys (topic changes, difficulty
    // changes) get fresh random picks, which is what keeps the batch
    // diverse — one topic × three difficulties gets three distinct
    // sets of exemplars per subject.
    const exemplarCache = new Map<string, ExemplarForPrompt[]>();
    // Knowledge Layer (premium plan §4): rendered learning-material
    // bundle per (subject, form, topic) + a per-subject "has any
    // chunks" skip-guard so un-ingested subjects pay zero retrieval
    // cost and fall back to today's behavior.
    const knowledgeCache = new Map<string, string>();
    const subjectHasChunks = new Map<string, boolean>();

    for (const selection of params.selections) {
      if (selection.mode === 'replace') {
        await this.pmTestQRepo
          .createQueryBuilder()
          .update(PmTestQuestion)
          .set({ status: QuestionStatus.ARCHIVED })
          .where('exam_type = :et', { et: params.examType })
          .andWhere('form_level = :fl', { fl: selection.formLevel })
          .andWhere('subject_id = :sid', { sid: selection.subjectId })
          .execute();
      }

      const subject = await this.subjectsRepo.findOne({
        where: { id: selection.subjectId },
      });
      if (!subject) {
        this.logger.warn(
          `pm-test: subject ${selection.subjectId} missing; skipping`,
        );
        failed += selection.questionCount;
        await this.jobsRepo.update(record.id, {
          completedItems: completed,
          failedItems: failed,
        });
        continue;
      }

      const topics = selection.syllabusTopicIds?.length
        ? await this.syllabusRepo.find({
            where: selection.syllabusTopicIds.map((id) => ({ id })),
          })
        : await this.syllabusRepo.find({
            where: {
              subjectId: selection.subjectId,
              examType: params.examType,
              formLevel: selection.formLevel,
              isActive: true,
            },
            take: 50,
          });

      const mix = distributeByDifficulty(
        selection.questionCount,
        selection.difficulty,
      );

      for (const diff of ['easy', 'medium', 'hard'] as const) {
        let remaining = mix[diff];
        const picks: Array<{
          topicTitle: string;
          topicId: string | null;
          diff: 'easy' | 'medium' | 'hard';
        }> = [];

        if (topics.length === 0) {
          // No curriculum topics configured yet — fall through with subject-only prompts.
          for (let i = 0; i < remaining; i++) {
            picks.push({
              topicTitle: subject.name,
              topicId: null,
              diff,
            });
          }
          remaining = 0;
        } else {
          let t = 0;
          while (remaining > 0) {
            const topic = topics[t % topics.length];
            picks.push({
              topicTitle: topic.title,
              topicId: topic.id,
              diff,
            });
            remaining -= 1;
            t += 1;
          }
        }

        for (let i = 0; i < picks.length; i += params.batchSize) {
          const batch = picks.slice(i, i + params.batchSize);
          const topicTitle = batch[0].topicTitle;
          // Instruction-layer prompt (system + user). Grounds on a
          // syllabus-context snippet built from the picked topic — for
          // subjects with no active syllabus topics we fall through
          // with the subject name as the topic and an empty context;
          // the shell's grounding rule still holds but the model has
          // less signal, so we accept a higher validator-reject rate
          // on that path.
          const topicRow = batch[0].topicId
            ? (topics.find((t) => t.id === batch[0].topicId) ?? null)
            : null;
          const legacyContext =
            topicRow?.description?.trim() ?? topicRow?.title ?? '';
          // Ground on the NaCCA curriculum when the subject is ingested;
          // falls back to the legacy topic description otherwise.
          const syllabusContext = await this.groundContext({
            subjectId: selection.subjectId,
            formLevel: selection.formLevel,
            topicTitle,
            legacyContext,
            cache: groundCache,
          });
          const pastPaperExemplars = await this.fetchExemplars({
            subjectId: selection.subjectId,
            syllabusTopicId: batch[0].topicId,
            difficulty: diff,
            cache: exemplarCache,
          });
          const referenceMaterial = await this.fetchReferenceMaterial({
            subjectId: selection.subjectId,
            formLevel: selection.formLevel,
            topicTitle,
            jobId: record.id,
            modelId,
            cache: knowledgeCache,
            hasChunksCache: subjectHasChunks,
          });
          // DB-served shell when AI_PROMPT_TEMPLATES_ENABLED (remediation
          // 1.2). Cached 60s inside the runtime service, so this is one
          // DB read per job in practice; null → compiled shell.
          const dbShell =
            await this.promptTemplates.activeShell('PM_TEST_GENERATION');
          const built = buildQuestionGenerationPrompt({
            examType: params.examType,
            subjectName: subject.name,
            formLevel: selection.formLevel,
            difficulty: diff,
            topicTitle,
            count: batch.length,
            syllabusContext,
            pastPaperExemplars,
            includeExplanations: params.includeExplanations,
            referenceMaterial,
            isQuantitativeSubject: isQuantitativeSubject({
              name: subject.name,
              code: subject.code,
            }),
            systemShellOverride: dbShell?.shell,
          });
          const promptVersion =
            dbShell?.version ?? QUESTION_GENERATION_PROMPT_VERSION;

          const isQuant = isQuantitativeSubject({
            name: subject.name,
            code: subject.code,
          });
          // Content-aware token budget (remediation 0.4). The old
          // `200 + n*500` truncated quantitative batches mid-JSON —
          // a question with the mandated Solution + Worked Example
          // easily exceeds 500 tokens on its own.
          const tokenBudget =
            400 +
            batch.length * (isQuant ? 1100 : 700) +
            (params.includeExplanations ? batch.length * 500 : 0);

          const invokeBatch = (
            userPrompt: string,
            maxTokens: number,
          ): ReturnType<typeof this.ai.callBedrock> =>
            this.callBedrockWithBackoff(
              () =>
                this.ai.callBedrock(userPrompt, modelId, {
                  system: built.system,
                  action: AiAction.QUESTION_GEN,
                  jobId: record.id,
                  maxTokens,
                  // Prefill + prompt-cache (remediation 1.3): `[`
                  // structurally kills preamble/fences; the ~1.4k-token
                  // static shell is billed once per cache window.
                  prefill: '[',
                  cacheSystemPrompt: true,
                  promptVersion,
                }),
              `pm-test-batch ${topicTitle}/${diff}`,
            );

          let call: Awaited<ReturnType<typeof this.ai.callBedrock>> | null =
            null;
          try {
            // Spec §4.4: exponential backoff, 3 attempts.
            call = await invokeBatch(built.user, tokenBudget);
            totalCost += call.costUsd;

            // Truncation (remediation 0.4): `max_tokens` means the
            // JSON tail is missing no matter how it parses. One retry
            // with 1.5× budget, then give up with a DISTINCT reason so
            // ops can tell "we cut it off" from "model wrote garbage".
            if (call.stopReason === 'max_tokens') {
              this.logger.warn(
                `pm-test batch (${topicTitle}, ${diff}) truncated at ${tokenBudget} tokens; retrying with 1.5× budget`,
              );
              call = await invokeBatch(
                built.user,
                Math.ceil(tokenBudget * 1.5),
              );
              totalCost += call.costUsd;
            }

            if (this.exceedsJobCostCap(record, totalCost)) {
              this.logger.error(
                `[ai-job] aborting pm-test ${record.id}: running cost $${totalCost.toFixed(2)} exceeds ${AiGenerationProcessor.JOB_COST_CAP_MULTIPLIER}× estimate ($${record.estimatedCostUsd}).`,
              );
              throw new Error(
                `Job aborted: running cost exceeded ${AiGenerationProcessor.JOB_COST_CAP_MULTIPLIER}× the pre-submit estimate.`,
              );
            }
          } catch (err) {
            // Bedrock transport failure (post-backoff). Nothing to
            // validate. Whole batch counts as failed and we log to the
            // reject-log so ops can see WHY the generation broke —
            // "the model 500'd" vs "the model produced garbage" have
            // very different remediations.
            failed += batch.length;
            this.logger.warn(
              `pm-test batch (${topicTitle}, ${diff}, ${batch.length}) transport failed: ${(err as Error).message}`,
            );
            await this.recordRejectSafely({
              jobId: record.id,
              action: 'question_generation',
              modelId,
              reason: 'bedrock_transport_error',
              detail: (err as Error).message,
            });
            await this.jobsRepo.update(record.id, {
              completedItems: completed,
              failedItems: failed,
              actualCostUsd: totalCost.toFixed(4),
            });
            continue;
          }

          if (call.stopReason === 'max_tokens') {
            // Still truncated after the bigger retry — distinct reject
            // reason (remediation 0.4).
            failed += batch.length;
            await this.recordRejectSafely({
              jobId: record.id,
              action: 'question_generation',
              modelId,
              reason: 'max_tokens_truncation',
              detail: `output still truncated at ${Math.ceil(tokenBudget * 1.5)} tokens`,
              rawOutput: call.content,
            });
            await this.jobsRepo.update(record.id, {
              completedItems: completed,
              failedItems: failed,
              actualCostUsd: totalCost.toFixed(4),
            });
            continue;
          }

          // Per-item validation with salvage (remediation 0.5): good
          // items are kept; bad items are logged individually and get
          // ONE reflexion retry. One bad item no longer bills the
          // whole batch.
          //
          // `requireWorkedExampleForBatch` fires when the subject is
          // quantitative — an "if the question is calc-shaped, we
          // still enforce" per-question guard runs inside the
          // validator so a numeric item in a non-quantitative
          // subject also gets a Worked Example.
          const validationOpts = {
            requireWorkedExampleForBatch: isQuant,
            requestedDifficulty: diff,
            expectedCount: batch.length,
          };
          let salvage = validateQuestionBatchSalvage(
            call.content,
            validationOpts,
          );

          // Reflexion retry (remediation 0.5): tell the model exactly
          // what was rejected and ask for corrected items only. One
          // retry per batch, then accept what we have.
          const needsRetry = !salvage.ok || salvage.rejected.length > 0;
          if (needsRetry && !this.exceedsJobCostCap(record, totalCost)) {
            const missing = salvage.ok
              ? batch.length - salvage.value.length
              : batch.length;
            const rejectionNote = salvage.ok
              ? salvage.rejected
                  .map((r) => `- item ${r.index}: ${r.reason} — ${r.detail}`)
                  .join('\n')
              : `- entire output: ${salvage.reason} — ${salvage.detail}`;
            const reflexionUser = `${built.user}

Your previous output for this exact request was rejected by an
automated validator:
${rejectionNote}

Produce EXACTLY ${Math.max(1, missing)} corrected question(s) that fix the
problems above. Same schema, same rules. Return ONLY the JSON array.`;
            try {
              const retry = await invokeBatch(
                reflexionUser,
                400 + Math.max(1, missing) * (isQuant ? 1600 : 1200),
              );
              totalCost += retry.costUsd;
              const retrySalvage = validateQuestionBatchSalvage(retry.content, {
                ...validationOpts,
                expectedCount: Math.max(1, missing),
              });
              if (retrySalvage.ok) {
                salvage = salvage.ok
                  ? {
                      ...salvage,
                      value: [...salvage.value, ...retrySalvage.value],
                      rejected: retrySalvage.rejected,
                    }
                  : retrySalvage;
              }
            } catch (err) {
              this.logger.warn(
                `pm-test reflexion retry (${topicTitle}, ${diff}) failed: ${(err as Error).message}`,
              );
            }
          }

          if (!salvage.ok) {
            failed += batch.length;
            this.logger.warn(
              `pm-test batch (${topicTitle}, ${diff}) rejected: ${salvage.reason} — ${salvage.detail}`,
            );
            await this.recordRejectSafely({
              jobId: record.id,
              action: 'question_generation',
              modelId,
              reason: salvage.reason,
              detail: salvage.detail,
              rawOutput: call.content,
            });
            await this.jobsRepo.update(record.id, {
              completedItems: completed,
              failedItems: failed,
              actualCostUsd: totalCost.toFixed(4),
            });
            continue;
          }

          // Per-item rejects that survived the reflexion retry — log
          // each with its own reason (the reject-log already had
          // failedIndex plumbing; now it gets used).
          for (const r of salvage.rejected) {
            await this.recordRejectSafely({
              jobId: record.id,
              action: 'question_generation',
              modelId,
              reason: r.reason,
              detail: r.detail,
              rawOutput: call.content,
            });
          }
          for (const w of salvage.warnings) {
            this.logger.warn(`pm-test batch (${topicTitle}, ${diff}): ${w}`);
          }

          const generated: ParsedQuestion[] = salvage.value.slice(
            0,
            batch.length,
          );
          for (let j = 0; j < generated.length; j++) {
            // Server-side answer-position shuffle (remediation 0.7) —
            // deterministic A–D balance instead of begging the model.
            const spec = shuffleOptions(generated[j]);
            for (const w of spec.warnings) {
              this.logger.warn(
                `pm-test item (${topicTitle}, ${diff}) warning: ${w}`,
              );
            }

            // Blind second-pass answer verification (remediation 0.1).
            // Disagreement doesn't discard the item — it lands in the
            // review queue marked key_mismatch so a human arbitrates.
            let verificationStatus: string | null = null;
            let verifierModel: string | null = null;
            if (this.answerVerifier.enabled) {
              const correct = spec.options.find((o) => o.isCorrect)!;
              const outcome = await this.answerVerifier.verify(
                {
                  stem: spec.body,
                  options: spec.options.map((o) => ({
                    label: o.label,
                    body: o.body,
                  })),
                  // Same retrieval bundle as the generator — the
                  // verifier grounds its blind solve on the textbook.
                  referenceMaterial: referenceMaterial || undefined,
                  jobId: record.id,
                },
                correct.label,
              );
              totalCost += outcome.costUsd;
              verificationStatus = outcome.status;
              verifierModel = outcome.model;
              if (outcome.status === 'key_mismatch') {
                await this.recordRejectSafely({
                  jobId: record.id,
                  action: 'question_generation',
                  modelId,
                  reason: 'verifier_key_mismatch',
                  detail: `verifier picked ${outcome.pickedLabel} over ${correct.label}: ${outcome.reason}`,
                  rawOutput: spec.body,
                });
              }
            }

            // Strict-mode grounding check (premium plan §4): for
            // hallucination-sensitive subjects, an item whose facts the
            // textbook can't support is REJECTED, not published. Only
            // runs when reference material was actually retrieved —
            // with nothing to check against, strict degrades to
            // anchored rather than rejecting everything.
            if (
              subject.aiRetrievalMode === 'strict' &&
              referenceMaterial &&
              this.answerVerifier.enabled
            ) {
              const correct = spec.options.find((o) => o.isCorrect)!;
              const grounding = await this.answerVerifier.checkGrounding({
                stem: spec.body,
                correctAnswerText: correct.body,
                referenceMaterial,
                jobId: record.id,
              });
              if (grounding && !grounding.grounded) {
                failed += 1;
                await this.recordRejectSafely({
                  jobId: record.id,
                  action: 'question_generation',
                  modelId,
                  reason: 'retrieval_ungrounded_claim',
                  detail: grounding.detail || 'unsupported factual claim',
                  rawOutput: spec.body,
                });
                continue;
              }
            }

            const target = batch[Math.min(j, batch.length - 1)];
            await this.insertPmTestQuestion({
              subjectId: selection.subjectId,
              syllabusTopicId: target.topicId,
              examType: params.examType,
              formLevel: selection.formLevel,
              difficulty: spec.difficulty as Difficulty,
              body: spec.body,
              explanation: params.includeExplanations
                ? spec.explanation || null
                : null,
              options: spec.options,
              generationBatchId: record.id,
              verificationStatus,
              verifierModel,
            });
            completed += 1;
          }
          failed += Math.max(0, batch.length - generated.length);

          await this.jobsRepo.update(record.id, {
            completedItems: completed,
            failedItems: failed,
            actualCostUsd: totalCost.toFixed(4),
          });
        }
      }
    }
  }

  private async insertPmTestQuestion(input: {
    subjectId: string;
    syllabusTopicId: string | null;
    examType: ExamType;
    formLevel: number;
    difficulty: Difficulty;
    body: string;
    explanation: string | null;
    options: Array<{ label: string; body: string; isCorrect: boolean }>;
    generationBatchId: string;
    verificationStatus?: string | null;
    verifierModel?: string | null;
  }): Promise<void> {
    const q = this.pmTestQRepo.create({
      subjectId: input.subjectId,
      syllabusTopicId: input.syllabusTopicId,
      examType: input.examType,
      formLevel: input.formLevel,
      difficulty: input.difficulty,
      body: input.body,
      explanation: input.explanation,
      status: QuestionStatus.PENDING_REVIEW,
      generationBatchId: input.generationBatchId,
      verificationStatus: input.verificationStatus ?? null,
      verifierModel: input.verifierModel ?? null,
    });
    const saved = await this.pmTestQRepo.save(q);
    const opts = input.options.map((o) =>
      this.pmTestORepo.create({
        questionId: saved.id,
        label: o.label,
        body: o.body,
        isCorrect: o.isCorrect,
      }),
    );
    await this.pmTestORepo.save(opts);
  }

  /**
   * Spec §4.4: "On API failure: exponential backoff 3 attempts, then marks
   * batch failed." 3 total attempts with delays 500ms, 1000ms, 2000ms.
   * Wraps any Bedrock call so transient ThrottlingException / 5xx don't
   * fail the whole job.
   */
  private async callBedrockWithBackoff<T>(
    call: () => Promise<T>,
    label: string,
  ): Promise<T> {
    const delays = [500, 1000, 2000];
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await call();
      } catch (err) {
        lastErr = err;
        this.logger.warn(
          `${label} attempt ${attempt + 1}/3 failed: ${(err as Error).message}`,
        );
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
    }
    throw lastErr as Error;
  }

  // ---- Bulk explanation generation -----------------------------------------

  private async runExplanationJob(record: AiGenerationJob): Promise<void> {
    const params = record.parameters as unknown as ExplanationBulkParams;
    const modelId = resolveModelId(params.dto.model);
    let completed = 0;
    let failed = 0;
    let totalCost = 0;
    // Skip-guard: remember per subject whether it has ANY approved+embedded
    // indicator. Subjects with none never trigger an embedding query, so
    // un-ingested subjects pay zero grounding cost/latency.
    const embeddedSubjectCache = new Map<string, boolean>();
    // Same skip-guard for learning-material chunks (Knowledge Layer).
    const chunkSubjectCache = new Map<string, boolean>();

    // Spec §5.2 step 1: fetch question ids in batches of 50. Each DB round-trip
    // hydrates 50 questions + options + subjects; AI calls remain per-question.
    const BATCH = 50;
    const ids = params.questionIds;
    outer: for (let start = 0; start < ids.length; start += BATCH) {
      const slice = ids.slice(start, start + BATCH);
      const batch = await this.questionsRepo.find({
        where: slice.map((id) => ({ id })),
        // `stimulus` = the shared passage/table block behind grouped
        // items — English comprehension and Biology data questions are
        // unsolvable (and un-explainable) without it.
        relations: ['options', 'subject', 'stimulus'],
      });
      const byId = new Map(batch.map((row) => [row.id, row]));

      for (const id of slice) {
        const q = byId.get(id);
        if (!q) {
          failed += 1;
          continue;
        }
        const correct = q.options.find((o) => o.isCorrect);
        if (!correct) {
          failed += 1;
          this.logger.warn(`question ${id} has no correct option; skipping`);
          continue;
        }

        // Stimulus handling: text stimuli ride into the prompt; an
        // IMAGE-ONLY stimulus (image_url with no usable body text)
        // cannot be seen by a text model — generating anyway would
        // hallucinate or trip the key-mismatch guard and wrongly pull
        // a good question into review. Skip with a distinct reason so
        // ops can see how much of the bank needs image transcription.
        const stimulusBody = q.stimulus?.body?.trim() ?? '';
        if (q.stimulus && !stimulusBody && q.stimulus.imageUrl) {
          failed += 1;
          await this.recordRejectSafely({
            jobId: record.id,
            action: 'explanation',
            modelId,
            reason: 'stimulus_image_unsupported',
            detail: `question ${q.id} has an image-only stimulus (${q.stimulus.id}) — text models cannot see it; add a text transcription to the stimulus body to enable AI explanations`,
          });
          await this.jobsRepo.update(record.id, {
            completedItems: completed,
            failedItems: failed,
            actualCostUsd: totalCost.toFixed(4),
          });
          continue;
        }

        // Ground the explanation on the NaCCA curriculum when the subject
        // is ingested. Gated behind a cached existence check so un-ingested
        // subjects never trigger an embedding query (see groundExplanation).
        let syllabusContext: string | undefined;
        const subjId = q.subject?.id;
        if (subjId) {
          let hasEmb = embeddedSubjectCache.get(subjId);
          if (hasEmb === undefined) {
            hasEmb = await this.syllabusRetrieval
              .hasEmbeddedIndicators(subjId)
              .catch(() => false);
            embeddedSubjectCache.set(subjId, hasEmb);
          }
          if (hasEmb) {
            syllabusContext = await this.groundExplanation(subjId, q.body);
          }
        }

        // Knowledge Layer: retrieve textbook chunks by the question stem
        // so the explanation teaches the method in the book's own voice.
        let referenceMaterial: string | undefined;
        if (subjId) {
          let hasChunks = chunkSubjectCache.get(subjId);
          if (hasChunks === undefined) {
            hasChunks = await this.knowledge
              .hasChunks(subjId)
              .catch(() => false);
            chunkSubjectCache.set(subjId, hasChunks);
          }
          if (hasChunks) {
            try {
              const bundle = await this.knowledge.retrieveForGeneration({
                subjectId: subjId,
                formLevel: null,
                queryText: q.body,
              });
              if (!bundle.empty) {
                referenceMaterial =
                  this.knowledge.renderReferenceMaterial(bundle);
              }
            } catch (err) {
              this.logger.warn(
                `[knowledge] explanation retrieval failed q=${q.id}: ${(err as Error).message}`,
              );
            }
          }
        }

        // Subject allowlist OR per-question content heuristic — same
        // "either signal wins" pattern used at the pm-test regen
        // site so a calc-shaped item outside a quantitative subject
        // (e.g. Economics numeric, Biology titration) still gets the
        // full Solution + Worked Example treatment.
        const quantitative =
          isQuantitativeSubject({
            name: q.subject?.name,
            code: q.subject?.code,
          }) ||
          looksLikeCalcQuestion({
            stem: q.body,
            options: q.options,
          });
        const dbShell = await this.promptTemplates.activeShell('EXPLANATION');
        const built = buildExplanationPrompt({
          examType: q.examType,
          subjectName:
            q.subject?.name ??
            (q.examType === ExamType.BECE ? 'BECE subject' : 'WASSCE subject'),
          formLevel: null,
          questionBody: q.body,
          options: q.options.map((o) => ({ label: o.label, body: o.body })),
          correctLabel: correct.label,
          syllabusContext,
          referenceMaterial,
          stimulus: stimulusBody
            ? { title: q.stimulus?.title ?? null, body: stimulusBody }
            : undefined,
          isQuantitativeSubject: quantitative,
          systemShellOverride: dbShell?.shell,
        });

        let call: Awaited<ReturnType<typeof this.ai.callBedrock>> | null = null;
        try {
          call = await this.ai.callBedrock(built.user, modelId, {
            system: built.system,
            action: AiAction.EXPLANATION,
            jobId: record.id,
            // Budgets sized for the contract's upper bound (~600 words
            // ≈ 850+ tokens with LaTeX) — remediation 0.4.
            maxTokens: quantitative ? 1600 : 900,
            cacheSystemPrompt: true,
            promptVersion: dbShell?.version ?? EXPLANATION_PROMPT_VERSION,
          });
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `explanation ${id} transport failed: ${(err as Error).message}`,
          );
          await this.recordRejectSafely({
            jobId: record.id,
            action: 'explanation',
            modelId,
            reason: 'bedrock_transport_error',
            detail: (err as Error).message,
          });
          await this.jobsRepo.update(record.id, {
            completedItems: completed,
            failedItems: failed,
            actualCostUsd: totalCost.toFixed(4),
          });
          continue;
        }
        totalCost += call.costUsd;

        // Validator gate — students never see a malformed explanation.
        const validation = validateExplanation(call.content, q.body, {
          requireWorkedExample: quantitative,
          correctOptionText: correct.body,
        });
        if (!validation.ok) {
          failed += 1;
          this.logger.warn(
            `explanation ${id} rejected: ${validation.reason} — ${validation.detail}`,
          );
          await this.recordRejectSafely({
            jobId: record.id,
            action: 'explanation',
            modelId,
            reason: validation.reason,
            detail: validation.detail,
            rawOutput: call.content,
          });
          // Key-mismatch (remediation B1): the model solved the
          // question independently and DISAGREES with the stored key.
          // That's a data-quality signal about the QUESTION, not a
          // generation failure — pull the item from circulation into
          // the review queue and keep its previous explanation intact.
          if (
            validation.reason === 'key_mismatch' ||
            validation.reason === 'ambiguous_question'
          ) {
            await this.questionsRepo.update(q.id, {
              status: QuestionStatus.PENDING_REVIEW,
            });
            this.logger.warn(
              `question ${q.id} routed to PENDING_REVIEW: ${validation.reason} — ${validation.detail}`,
            );
          }
          await this.jobsRepo.update(record.id, {
            completedItems: completed,
            failedItems: failed,
            actualCostUsd: totalCost.toFixed(4),
          });
          continue;
        }

        await this.questionsRepo.update(q.id, {
          explanation: validation.content,
          explanationHtml: sanitizeHtml(call.contentHtml),
          explanationModel: modelId,
          explanationGeneratedAt: new Date(),
        });
        completed += 1;

        await this.jobsRepo.update(record.id, {
          completedItems: completed,
          failedItems: failed,
          actualCostUsd: totalCost.toFixed(4),
        });

        // Runaway-cost circuit breaker — evaluated AFTER the paid, validated
        // explanation is persisted, so a billed generation is never discarded
        // (the old placement threw before the save and lost the call). Stops
        // the job from processing the remaining items.
        if (this.exceedsJobCostCap(record, totalCost)) {
          this.logger.error(
            `[ai-job] aborting explanation ${record.id}: running cost $${totalCost.toFixed(2)} exceeds ${AiGenerationProcessor.JOB_COST_CAP_MULTIPLIER}× estimate ($${record.estimatedCostUsd}).`,
          );
          await this.recordRejectSafely({
            jobId: record.id,
            action: 'explanation',
            modelId,
            reason: 'job_cost_cap_exceeded',
            detail: `Running cost $${totalCost.toFixed(4)} exceeded ${AiGenerationProcessor.JOB_COST_CAP_MULTIPLIER}× the estimate ($${record.estimatedCostUsd}); remaining items skipped.`,
          });
          break outer;
        }
      }
    }
  }
}
