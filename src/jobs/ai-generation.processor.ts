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
  type ExemplarForPrompt,
} from '../modules/ai/instruction-layer/question-generation.prompt';
import { buildExplanationPrompt } from '../modules/ai/instruction-layer/explanation.prompt';
import { SyllabusRetrievalService } from '../modules/syllabus/syllabus-retrieval.service';
import { PromptExemplarService } from '../modules/ai/prompt-exemplars.service';
import {
  validateQuestionBatch,
  type ParsedQuestion,
} from '../modules/ai/validation/question.validator';
import { validateExplanation } from '../modules/ai/validation/explanation.validator';
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
    private readonly exemplars: PromptExemplarService,
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
        const block = [
          'NaCCA syllabus indicators (each is a required learning point — ground the questions strictly on these):',
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
      return [
        'NaCCA syllabus indicators (ground the explanation strictly on these):',
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
          });

          let call: Awaited<ReturnType<typeof this.ai.callBedrock>> | null =
            null;
          try {
            // Spec §4.4: exponential backoff, 3 attempts.
            call = await this.callBedrockWithBackoff(
              () =>
                this.ai.callBedrock(built.user, modelId, {
                  system: built.system,
                  action: AiAction.QUESTION_GEN,
                  jobId: record.id,
                  maxTokens: 200 + batch.length * 500,
                }),
              `pm-test-batch ${topicTitle}/${diff}`,
            );
            totalCost += call.costUsd;
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

          // Rule-based validator replaces the inline guard-parse.
          // Rejections don't insert anything and land in the log so
          // ops can spot patterns (e.g. one model consistently misses
          // "exactly one correct answer").
          const validation = validateQuestionBatch(call.content);
          if (!validation.ok) {
            failed += batch.length;
            this.logger.warn(
              `pm-test batch (${topicTitle}, ${diff}) rejected: ${validation.reason} — ${validation.detail}`,
            );
            await this.recordRejectSafely({
              jobId: record.id,
              action: 'question_generation',
              modelId,
              reason: validation.reason,
              detail: validation.detail,
              rawOutput: call.content,
            });
            await this.jobsRepo.update(record.id, {
              completedItems: completed,
              failedItems: failed,
              actualCostUsd: totalCost.toFixed(4),
            });
            continue;
          }

          const generated: ParsedQuestion[] = validation.value;
          for (let j = 0; j < generated.length; j++) {
            const spec = generated[j];
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
            });
            completed += 1;
          }
          // If the validator returned fewer items than requested (the
          // batch validator is all-or-nothing today, but future rules
          // may drop individual items), reflect the shortfall.
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

    // Spec §5.2 step 1: fetch question ids in batches of 50. Each DB round-trip
    // hydrates 50 questions + options + subjects; AI calls remain per-question.
    const BATCH = 50;
    const ids = params.questionIds;
    outer: for (let start = 0; start < ids.length; start += BATCH) {
      const slice = ids.slice(start, start + BATCH);
      const batch = await this.questionsRepo.find({
        where: slice.map((id) => ({ id })),
        relations: ['options', 'subject'],
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
        });

        let call: Awaited<ReturnType<typeof this.ai.callBedrock>> | null = null;
        try {
          call = await this.ai.callBedrock(built.user, modelId, {
            system: built.system,
            action: AiAction.EXPLANATION,
            jobId: record.id,
            maxTokens: 600,
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
        const validation = validateExplanation(call.content, q.body);
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
