import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Question } from '../questions/entities/question.entity';
import { QuestionStatus, Difficulty } from '../../common/types/enums';
import { SyllabusTopic } from '../subjects/entities/syllabus-topic.entity';

export interface Exemplar {
  id: string;
  body: string;
  options: Array<{ label: string; body: string; isCorrect: boolean }>;
  explanation: string | null;
  year: number | null;
  paper: number | null;
  difficulty: Difficulty;
  /**
   * How the exemplar was matched — for admin telemetry, so ops can tell
   * "we grounded on 3 topic-scoped past questions" apart from "we had
   * nothing better than random subject-wide samples".
   */
  matchTier:
    | 'topic_difficulty'
    | 'topic_any'
    | 'subject_difficulty'
    | 'subject_any';
}

export interface FetchExemplarsArgs {
  subjectId: string;
  /** Populated when the caller has a syllabus_topic in hand — enables the two tightest tiers. */
  syllabusTopicId?: string | null;
  difficulty: Difficulty;
  /** Upper bound on rows returned. Default 3. */
  k?: number;
}

/**
 * Pulls past-paper questions to serve as few-shot exemplars for
 * Bondzi Test generation. This is the fix for the "According to the
 * syllabus…" question pattern: the model imitates whatever style it
 * sees, so showing it 3 real WAEC stems on the same topic pulls it
 * back toward WAEC's actual voice.
 *
 * Four-tier fallback so a partially-tagged corpus still finds
 * something:
 *
 *   1. **topic_difficulty** — same subject + same
 *      syllabus_topic_id + same difficulty. Preferred.
 *   2. **topic_any**        — same subject + syllabus_topic_id, any
 *      difficulty. Still topic-scoped.
 *   3. **subject_difficulty** — same subject + same difficulty. No
 *      topic scope; picks anything the subject has.
 *   4. **subject_any**      — same subject, any difficulty. Last
 *      resort so partially-ingested subjects still ground on
 *      *something* rather than nothing.
 *
 * Rejects rows that would hurt more than they help:
 *   - status ≠ 'active' (drafts / archived)
 *   - is_verified = false (unreviewed content)
 *   - flag_count > 0 (student-reported problems)
 *   - body shorter than 30 chars (stems too short to model)
 *   - fewer than 4 options (broken row)
 *   - no explanation (nothing to show the model as an example
 *     rationale — the whole point is stylistic transfer including
 *     the explanation voice)
 *
 * Randomised within a tier so consecutive batches don't feed the
 * model the same 3 stems every time (which would collapse output
 * diversity). Random is seeded per-call via `random()` in Postgres
 * — deterministic tests use the returned array as-is.
 */
@Injectable()
export class PromptExemplarService {
  private readonly logger = new Logger(PromptExemplarService.name);

  constructor(
    @InjectRepository(Question)
    private readonly questionsRepo: Repository<Question>,
    @InjectRepository(SyllabusTopic)
    private readonly syllabusTopicsRepo: Repository<SyllabusTopic>,
  ) {}

  async fetch(args: FetchExemplarsArgs): Promise<Exemplar[]> {
    const k = Math.max(1, Math.min(5, args.k ?? 3));

    const tiers: Array<{
      name: Exemplar['matchTier'];
      run: () => Promise<Question[]>;
    }> = [];

    if (args.syllabusTopicId) {
      tiers.push({
        name: 'topic_difficulty',
        run: () =>
          this.fetchByTopic(
            args.subjectId,
            args.syllabusTopicId!,
            args.difficulty,
            k,
          ),
      });
      tiers.push({
        name: 'topic_any',
        run: () =>
          this.fetchByTopic(args.subjectId, args.syllabusTopicId!, null, k),
      });
    }
    tiers.push({
      name: 'subject_difficulty',
      run: () => this.fetchBySubject(args.subjectId, args.difficulty, k),
    });
    tiers.push({
      name: 'subject_any',
      run: () => this.fetchBySubject(args.subjectId, null, k),
    });

    const seen = new Set<string>();
    const out: Exemplar[] = [];
    for (const tier of tiers) {
      if (out.length >= k) break;
      let rows: Question[] = [];
      try {
        rows = await tier.run();
      } catch (err) {
        this.logger.warn(
          `[exemplars] tier=${tier.name} subject=${args.subjectId} query failed: ${(err as Error).message}`,
        );
        continue;
      }
      for (const row of rows) {
        if (out.length >= k) break;
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const opts = (row.options ?? [])
          .filter((o) => typeof o.body === 'string' && o.body.trim().length > 0)
          .map((o) => ({
            label: o.label ?? '',
            body: o.body,
            isCorrect: o.isCorrect,
          }));
        if (opts.length < 4) continue;
        if (opts.filter((o) => o.isCorrect).length !== 1) continue;
        out.push({
          id: row.id,
          body: row.body,
          options: opts.slice(0, 4),
          explanation: row.explanation,
          year: row.year,
          paper: row.wassecPaper,
          difficulty: row.difficulty,
          matchTier: tier.name,
        });
      }
    }
    if (out.length === 0) {
      this.logger.debug(
        `[exemplars] no past-paper matches found for subject=${args.subjectId} topic=${args.syllabusTopicId ?? 'null'} difficulty=${args.difficulty}`,
      );
    }
    return out;
  }

  /**
   * Topic-scoped fetch — bridges syllabus_topic to past-paper
   * questions via the indicator chain:
   *   syllabus_topics.source_content_standard_id
   *     → syllabus_indicators.content_standard_id
   *     → questions.syllabus_indicator_id
   *
   * If the topic has no `source_content_standard_id` (an admin
   * hand-authored topic that predates the ingestion bridge), we
   * return nothing — the fallback tiers will still cover it.
   */
  private async fetchByTopic(
    subjectId: string,
    syllabusTopicId: string,
    difficulty: Difficulty | null,
    limit: number,
  ): Promise<Question[]> {
    const topic = await this.syllabusTopicsRepo.findOne({
      where: { id: syllabusTopicId },
      select: ['id', 'sourceContentStandardId'],
    });
    if (!topic?.sourceContentStandardId) return [];

    const qb = this.questionsRepo
      .createQueryBuilder('q')
      .leftJoinAndSelect('q.options', 'o')
      .innerJoin(
        'syllabus_indicators',
        'li',
        'li.id = q.syllabus_indicator_id AND li.content_standard_id = :csId',
        { csId: topic.sourceContentStandardId },
      )
      .where('q.subject_id = :sid', { sid: subjectId })
      .andWhere('q.status = :st', { st: QuestionStatus.ACTIVE })
      .andWhere('q.is_verified = true')
      .andWhere('q.flag_count = 0')
      .andWhere('length(q.body) >= 30')
      .andWhere("coalesce(q.explanation, '') <> ''");

    if (difficulty) qb.andWhere('q.difficulty = :d', { d: difficulty });

    // random() so consecutive batches don't see the same 3 rows every
    // time — otherwise the model overfits its output to a narrow
    // stylistic band.
    qb.orderBy('random()').limit(limit);
    return qb.getMany();
  }

  private async fetchBySubject(
    subjectId: string,
    difficulty: Difficulty | null,
    limit: number,
  ): Promise<Question[]> {
    const qb = this.questionsRepo
      .createQueryBuilder('q')
      .leftJoinAndSelect('q.options', 'o')
      .where('q.subject_id = :sid', { sid: subjectId })
      .andWhere('q.status = :st', { st: QuestionStatus.ACTIVE })
      .andWhere('q.is_verified = true')
      .andWhere('q.flag_count = 0')
      .andWhere('length(q.body) >= 30')
      .andWhere("coalesce(q.explanation, '') <> ''");
    if (difficulty) qb.andWhere('q.difficulty = :d', { d: difficulty });
    qb.orderBy('random()').limit(limit);
    return qb.getMany();
  }
}
