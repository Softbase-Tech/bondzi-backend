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
  AiAction,
  AiJobStatus,
  AiJobType,
  Difficulty,
  ExamType,
  NotificationChannel,
  QuestionStatus,
  SchoolLevel,
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

/**
 * Shape the Claude response for PM Test generation must conform to.
 * Anything that doesn't match is logged and skipped — NEVER inserted.
 */
interface GeneratedOption {
  label: string;
  body: string;
  isCorrect: boolean;
}

interface GeneratedQuestion {
  body: string;
  difficulty: 'easy' | 'medium' | 'hard';
  explanation?: string;
  options: GeneratedOption[];
}

function isGeneratedOption(v: unknown): v is GeneratedOption {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.label === 'string' &&
    o.label.length > 0 &&
    o.label.length <= 2 &&
    typeof o.body === 'string' &&
    o.body.length > 0 &&
    typeof o.isCorrect === 'boolean'
  );
}

function isGeneratedQuestion(v: unknown): v is GeneratedQuestion {
  if (!v || typeof v !== 'object') return false;
  const q = v as Record<string, unknown>;
  if (typeof q.body !== 'string' || q.body.length < 10) return false;
  if (
    q.difficulty !== 'easy' &&
    q.difficulty !== 'medium' &&
    q.difficulty !== 'hard'
  ) {
    return false;
  }
  if (q.explanation !== undefined && typeof q.explanation !== 'string') {
    return false;
  }
  if (!Array.isArray(q.options) || q.options.length !== 4) return false;
  if (!q.options.every(isGeneratedOption)) return false;
  const correctCount = q.options.filter((o) => o.isCorrect).length;
  return correctCount === 1;
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

function schoolLevelFor(examType: ExamType): SchoolLevel {
  return examType === ExamType.BECE ? SchoolLevel.JHS : SchoolLevel.SHS;
}

function stripCodeFences(text: string): string {
  // Claude occasionally wraps JSON in ```json ... ``` despite the instruction.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const m = text.match(fence);
  return m ? m[1] : text;
}

function parseGeneratedBatch(raw: string): GeneratedQuestion[] {
  const cleaned = stripCodeFences(raw.trim());
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error('expected array of generated questions');
  }
  const valid: GeneratedQuestion[] = [];
  for (const item of parsed) {
    if (isGeneratedQuestion(item)) valid.push(item);
  }
  return valid;
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
  ) {
    super();
  }

  async process(bullJob: Job<GenerationJobData>): Promise<void> {
    const record = await this.jobsRepo.findOne({
      where: { id: bullJob.data.jobId },
    });
    if (!record) {
      this.logger.warn(`job ${bullJob.data.jobId} no longer exists; skipping.`);
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
          const prompt = this.buildPmTestPrompt({
            examType: params.examType,
            subjectName: subject.name,
            formLevel: selection.formLevel,
            difficulty: diff,
            topicTitle,
            count: batch.length,
            includeExplanations: params.includeExplanations,
          });

          try {
            // Spec §4.4: exponential backoff, 3 attempts.
            const call = await this.callBedrockWithBackoff(
              () =>
                this.ai.callBedrock(prompt, modelId, {
                  action: AiAction.QUESTION_GEN,
                  jobId: record.id,
                  maxTokens: 200 + batch.length * 500,
                }),
              `pm-test-batch ${topicTitle}/${diff}`,
            );
            totalCost += call.costUsd;
            const generated = parseGeneratedBatch(call.content);

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
                  ? (spec.explanation ?? null)
                  : null,
                options: spec.options,
                generationBatchId: record.id,
              });
              completed += 1;
            }
            failed += Math.max(0, batch.length - generated.length);
          } catch (err) {
            failed += batch.length;
            this.logger.warn(
              `pm-test batch (${topicTitle}, ${diff}, ${batch.length}) failed: ${(err as Error).message}`,
            );
          }

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

  private buildPmTestPrompt(args: {
    examType: ExamType;
    subjectName: string;
    formLevel: number;
    difficulty: 'easy' | 'medium' | 'hard';
    topicTitle: string;
    count: number;
    includeExplanations: boolean;
  }): string {
    const schoolLevel = schoolLevelFor(args.examType).toUpperCase();
    const explanationLine = args.includeExplanations
      ? '- Include a concise explanation (2–3 sentences) of why the answer is correct.'
      : '';
    return `You are an expert ${args.examType.toUpperCase()} exam question writer for Ghanaian students.
You create high-quality ${args.difficulty} multiple-choice questions for ${args.subjectName}
at Form ${args.formLevel} level (${schoolLevel}).

Generate exactly ${args.count} unique MCQ questions on the topic: ${args.topicTitle}.
Each question must:
- Be answerable by a Form ${args.formLevel} ${schoolLevel} student in Ghana
- Follow WAEC question format and style
- Have exactly 4 options (A, B, C, D)
- Have exactly one correct answer
${explanationLine}

Return ONLY a valid JSON array. No preamble. No markdown fences. No commentary.
Format: [{"body":"...","difficulty":"${args.difficulty}","options":[{"label":"A","body":"...","isCorrect":false},...],"explanation":"..."}]`;
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

    // Spec §5.2 step 1: fetch question ids in batches of 50. Each DB round-trip
    // hydrates 50 questions + options + subjects; AI calls remain per-question.
    const BATCH = 50;
    const ids = params.questionIds;
    for (let start = 0; start < ids.length; start += BATCH) {
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

        const prompt = this.buildExplanationPrompt({
          question: q,
          correctLabel: correct.label,
          correctBody: correct.body,
          options: q.options,
        });

        try {
          const call = await this.ai.callBedrock(prompt, modelId, {
            action: AiAction.EXPLANATION,
            jobId: record.id,
            maxTokens: 600,
          });
          totalCost += call.costUsd;
          await this.questionsRepo.update(q.id, {
            explanation: call.content,
            explanationHtml: sanitizeHtml(call.contentHtml),
            explanationModel: modelId,
            explanationGeneratedAt: new Date(),
          });
          completed += 1;
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `explanation ${id} failed: ${(err as Error).message}`,
          );
        }

        await this.jobsRepo.update(record.id, {
          completedItems: completed,
          failedItems: failed,
          actualCostUsd: totalCost.toFixed(4),
        });
      }
    }
  }

  private buildExplanationPrompt(args: {
    question: Question;
    correctLabel: string;
    correctBody: string;
    options: Option[];
  }): string {
    const schoolLevel = schoolLevelFor(args.question.examType).toUpperCase();
    const formLevelNote = args.question.year
      ? `Form 3 ${schoolLevel}`
      : `Form 3 ${schoolLevel}`;
    const subjectName =
      args.question.subject?.name ??
      (args.question.examType === ExamType.BECE
        ? 'BECE subject'
        : 'WASSCE subject');
    const optionsBlock = args.options
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((o) => `${o.label}. ${o.body}`)
      .join('\n');

    return `You are a patient, encouraging tutor helping a Ghanaian
${schoolLevel} student (${formLevelNote}) prepare for their ${args.question.examType.toUpperCase()} examination.

Question (${subjectName}):
${args.question.body}

Options:
${optionsBlock}

Correct answer: ${args.correctLabel}. ${args.correctBody}

Write a clear explanation (maximum 150 words) that:
1. States why the correct answer is right, simply and directly.
2. Explains why the wrong options are incorrect.
3. Uses language appropriate for ${formLevelNote} level.

Write in plain paragraphs. No bullet points. No headers.
Do not mention 'WAEC' or 'exam'. Address the student directly.`;
  }
}
