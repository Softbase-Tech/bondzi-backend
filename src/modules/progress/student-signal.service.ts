import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import {
  WeaknessService,
  type SyllabusWeakTopic,
  type PastPaperWeakTopic,
} from './weakness.service';
import {
  KnowledgeRetrievalService,
  type RemediationRef,
} from '../syllabus/knowledge-retrieval.service';

/**
 * Shared grounded signal bundle for every student-facing AI feature
 * (premium plan §6.2). Replaces the three divergent inline data
 * assemblies in weakness narratives, AI reviews, and post-exam
 * breakdowns with ONE typed shape that carries:
 *
 *   • weak + strong topic rollups WITH their syllabus_topic ids (the
 *     spine — previously dropped, leaving prompts ungrounded)
 *   • a 4-week accuracy trend (reviews describe direction, not just
 *     today's snapshot)
 *   • the most recent wrong answers (concrete evidence beats vague
 *     "you struggle with X")
 *   • remediation citations from the Knowledge Layer (Shape 2 —
 *     section titles + pages, so "next steps" name actual textbook
 *     reading instead of hand-waving)
 *
 * PII rule: the bundle carries NO name, phone, or email — user
 * identity never enters a prompt. Everything a consumer renders into
 * a prompt must be wrapped in <data> blocks (remediation 1.8).
 */

export interface TrendPoint {
  weekStart: string; // ISO date (Monday)
  attempts: number;
  accuracyPct: number | null; // null when no gradable attempts
}

export interface RecentMistake {
  stem160: string;
  chosen: string | null;
  correct: string | null;
  topicTitle: string | null;
  syllabusTopicId: string | null;
}

export interface StudentSignal {
  weakTopics: SyllabusWeakTopic[];
  weakPastPaperTopics: PastPaperWeakTopic[];
  strongTopics: SyllabusWeakTopic[];
  strongPastPaperTopics: PastPaperWeakTopic[];
  trend: TrendPoint[];
  recentMistakes: RecentMistake[];
  remediation: RemediationRef[];
  meta: { streakDays: number; mockExamsTaken: number };
  hasSignal: boolean;
}

@Injectable()
export class StudentSignalService {
  private readonly logger = new Logger(StudentSignalService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly weakness: WeaknessService,
    private readonly knowledge: KnowledgeRetrievalService,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
  ) {}

  async forUser(
    userId: string,
    filters: { subjectId?: string } = {},
  ): Promise<StudentSignal> {
    const [weak, strong, trend, recentMistakes, user, mockExamsTaken] =
      await Promise.all([
        this.weakness.forUser(userId, filters),
        this.weakness.strongestFor(userId, filters),
        this.trend(userId, filters.subjectId),
        this.recentMistakes(userId, filters.subjectId),
        this.usersRepo.findOne({
          where: { id: userId },
          select: ['id', 'streakDays'],
        }),
        this.dataSource
          .query(
            `SELECT count(*)::int AS n FROM exams
              WHERE user_id = $1 AND mode = 'mock_exam' AND status = 'completed'`,
            [userId],
          )
          .then((r: Array<{ n: number }>) => r[0]?.n ?? 0),
      ]);

    // Remediation citations for the weak SYLLABUS topics (past-paper
    // legacy topics have no chunk linkage — syllabus topics are the
    // reading spine). Best-effort: an empty result just means the
    // narrative recommends practice instead of reading.
    let remediation: RemediationRef[] = [];
    try {
      remediation = await this.knowledge.retrieveForRemediation({
        syllabusTopicIds: weak.syllabusWeakTopics.map((t) => t.syllabusTopicId),
      });
    } catch (err) {
      this.logger.warn(
        `[student-signal] remediation retrieval failed user=${userId}: ${(err as Error).message}`,
      );
    }

    const hasSignal =
      weak.pastPaperWeakTopics.length > 0 || weak.syllabusWeakTopics.length > 0;

    return {
      weakTopics: weak.syllabusWeakTopics,
      weakPastPaperTopics: weak.pastPaperWeakTopics,
      strongTopics: strong.syllabusWeakTopics,
      strongPastPaperTopics: strong.pastPaperWeakTopics,
      trend,
      recentMistakes,
      remediation,
      meta: { streakDays: user?.streakDays ?? 0, mockExamsTaken },
      hasSignal,
    };
  }

  /**
   * Render the signal as the <data>-wrapped block student-facing
   * prompts inject. One renderer so all three features describe the
   * same student the same way.
   */
  render(signal: StudentSignal): string {
    const topicLine = (t: SyllabusWeakTopic | PastPaperWeakTopic) =>
      `- ${t.title} (${t.subjectName}): ${t.correct}/${t.answered} correct`;
    const parts: string[] = [];
    const weakAll = [...signal.weakTopics, ...signal.weakPastPaperTopics];
    const strongAll = [...signal.strongTopics, ...signal.strongPastPaperTopics];
    if (weakAll.length) {
      parts.push(`Weak topics:\n${weakAll.map(topicLine).join('\n')}`);
    }
    if (strongAll.length) {
      parts.push(`Strong topics:\n${strongAll.map(topicLine).join('\n')}`);
    }
    if (signal.trend.length) {
      parts.push(
        `Accuracy trend (weekly):\n${signal.trend
          .map(
            (p) =>
              `- week of ${p.weekStart}: ${p.attempts} attempts, ${p.accuracyPct != null ? `${p.accuracyPct}%` : 'n/a'}`,
          )
          .join('\n')}`,
      );
    }
    if (signal.recentMistakes.length) {
      parts.push(
        `Recent mistakes:\n${signal.recentMistakes
          .map(
            (m) =>
              `- [${m.topicTitle ?? 'unknown topic'}] "${m.stem160}" — chose "${m.chosen ?? '—'}", correct was "${m.correct ?? '—'}"`,
          )
          .join('\n')}`,
      );
    }
    if (signal.remediation.length) {
      const byTopic = new Map(
        signal.weakTopics.map((t) => [t.syllabusTopicId, t.title]),
      );
      parts.push(
        `Recommended reading (cite these EXACTLY when recommending):\n${signal.remediation
          .flatMap((r) =>
            r.chunks.map(
              (c) =>
                `- [chunkId ${c.id}] "${c.sectionTitle}"${c.sourcePage ? ` (p. ${c.sourcePage})` : ''} — for topic "${byTopic.get(r.syllabusTopicId) ?? r.syllabusTopicId}"`,
            ),
          )
          .join('\n')}`,
      );
    }
    parts.push(
      `Habits: current streak ${signal.meta.streakDays} days, mock exams completed ${signal.meta.mockExamsTaken}.`,
    );
    return `<data type="student_signal">\n${parts.join('\n\n')}\n</data>`;
  }

  /** Stable hash of the signal — the AI Review idempotency key. */
  fingerprint(signal: StudentSignal): string {
    const basis = JSON.stringify({
      w: signal.weakTopics.map((t) => [
        t.syllabusTopicId,
        t.correct,
        t.answered,
      ]),
      wp: signal.weakPastPaperTopics.map((t) => [
        t.topicId,
        t.correct,
        t.answered,
      ]),
      s: signal.strongTopics.map((t) => [
        t.syllabusTopicId,
        t.correct,
        t.answered,
      ]),
      t: signal.trend,
      m: signal.recentMistakes.map((m) => m.stem160),
    });
    // FNV-1a — cheap, stable, collision-tolerant for this use (a
    // false match just serves a cached review one generation early).
    let h = 0x811c9dc5;
    for (let i = 0; i < basis.length; i++) {
      h ^= basis.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  private async trend(
    userId: string,
    subjectId?: string,
  ): Promise<TrendPoint[]> {
    const rows: Array<{
      week_start: string;
      attempts: number;
      accuracy: string | null;
    }> = await this.dataSource.query(
      `SELECT date_trunc('week', a.answered_at)::date AS week_start,
              count(*)::int AS attempts,
              avg(CASE WHEN a.is_correct THEN 1.0 ELSE 0.0 END)
                FILTER (WHERE a.is_correct IS NOT NULL) AS accuracy
         FROM exam_answers a
         JOIN exams e ON e.id = a.exam_id
         LEFT JOIN questions q1 ON a.question_pool = 'past_paper' AND q1.id = a.question_id
         LEFT JOIN pm_test_questions q2 ON a.question_pool = 'pm_test' AND q2.id = a.question_id
        WHERE e.user_id = $1
          AND a.answered_at >= now() - interval '28 days'
          AND ($2::uuid IS NULL OR coalesce(q1.subject_id, q2.subject_id) = $2)
        GROUP BY 1
        ORDER BY 1`,
      [userId, subjectId ?? null],
    );
    return rows.map((r) => ({
      weekStart: String(r.week_start).slice(0, 10),
      attempts: r.attempts,
      accuracyPct:
        r.accuracy != null ? Math.round(Number(r.accuracy) * 100) : null,
    }));
  }

  private async recentMistakes(
    userId: string,
    subjectId?: string,
  ): Promise<RecentMistake[]> {
    const rows: Array<{
      stem: string | null;
      chosen: string | null;
      correct: string | null;
      topic_title: string | null;
      syllabus_topic_id: string | null;
    }> = await this.dataSource.query(
      `SELECT left(coalesce(q1.body, q2.body), 160) AS stem,
              coalesce(o1.body, o2.body)            AS chosen,
              coalesce(c1.body, c2.body)            AS correct,
              coalesce(t.title, st.title)           AS topic_title,
              q2.syllabus_topic_id                  AS syllabus_topic_id
         FROM exam_answers a
         JOIN exams e ON e.id = a.exam_id
         LEFT JOIN questions q1        ON a.question_pool = 'past_paper' AND q1.id = a.question_id
         LEFT JOIN pm_test_questions q2 ON a.question_pool = 'pm_test'   AND q2.id = a.question_id
         LEFT JOIN topics t            ON t.id = q1.topic_id
         LEFT JOIN syllabus_topics st  ON st.id = q2.syllabus_topic_id
         LEFT JOIN options o1          ON a.question_pool = 'past_paper' AND o1.id = a.selected_option_id
         LEFT JOIN pm_test_options o2  ON a.question_pool = 'pm_test'   AND o2.id = a.selected_option_id
         LEFT JOIN options c1          ON a.question_pool = 'past_paper' AND c1.question_id = q1.id AND c1.is_correct
         LEFT JOIN pm_test_options c2  ON a.question_pool = 'pm_test'   AND c2.question_id = q2.id AND c2.is_correct
        WHERE e.user_id = $1
          AND a.is_correct = false
          AND ($2::uuid IS NULL OR coalesce(q1.subject_id, q2.subject_id) = $2)
        ORDER BY a.answered_at DESC
        LIMIT 5`,
      [userId, subjectId ?? null],
    );
    return rows
      .filter((r) => r.stem)
      .map((r) => ({
        stem160: r.stem!,
        chosen: r.chosen,
        correct: r.correct,
        topicTitle: r.topic_title,
        syllabusTopicId: r.syllabus_topic_id,
      }));
  }
}
