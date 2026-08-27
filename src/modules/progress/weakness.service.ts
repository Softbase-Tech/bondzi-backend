import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { Topic } from '../subjects/entities/topic.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { SyllabusTopic } from '../subjects/entities/syllabus-topic.entity';
import { QuestionPool } from '../../common/types/enums';

export interface PastPaperWeakTopic {
  topicId: string;
  title: string;
  subjectId: string;
  subjectName: string;
  answered: number;
  correct: number;
  accuracy: number;
}

export interface SyllabusWeakTopic {
  syllabusTopicId: string;
  title: string;
  subjectId: string;
  subjectName: string;
  formLevel: number | null;
  answered: number;
  correct: number;
  accuracy: number;
}

export interface WeaknessBySourceResponse {
  pastPaperWeakTopics: PastPaperWeakTopic[];
  syllabusWeakTopics: SyllabusWeakTopic[];
}

/**
 * Per-source weakness rollups. Powers the "your weakest topics" strips on the
 * mobile past-papers setup screen (past-paper topics) and level-tests setup
 * screen (syllabus topics).
 *
 * Two independent queries because the two question pools live in different
 * tables — `questions.topic_id` for past papers and
 * `pm_test_questions.syllabus_topic_id` for level tests. Denormalising into a
 * single rollup table would need a schema migration; for the volumes we
 * expect (< 5k answers/user in year 1) the ad-hoc query is fine.
 *
 * A topic only appears when the user has answered at least MIN_SAMPLES
 * questions from it, otherwise the "0/2 correct" line noise would swamp
 * genuine weak spots.
 */
const MIN_SAMPLES = 3;
const TOP_N = 5;

@Injectable()
export class WeaknessService {
  constructor(
    @InjectRepository(ExamAnswer)
    private readonly answersRepo: Repository<ExamAnswer>,
  ) {}

  async forUser(
    userId: string,
    filters: { subjectId?: string },
  ): Promise<WeaknessBySourceResponse> {
    const [pastPaperWeakTopics, syllabusWeakTopics] = await Promise.all([
      this.pastPaperWeakness(userId, filters.subjectId),
      this.syllabusWeakness(userId, filters.subjectId),
    ]);
    return { pastPaperWeakTopics, syllabusWeakTopics };
  }

  /**
   * Mirror rollup ordered by HIGHEST accuracy — the "what's going
   * well" half the AI Review/Insights signal needs (premium plan
   * §6.2). Same MIN_SAMPLES floor and shapes as forUser.
   */
  async strongestFor(
    userId: string,
    filters: { subjectId?: string },
  ): Promise<WeaknessBySourceResponse> {
    const [pastPaperWeakTopics, syllabusWeakTopics] = await Promise.all([
      this.pastPaperWeakness(userId, filters.subjectId, 'DESC'),
      this.syllabusWeakness(userId, filters.subjectId, 'DESC'),
    ]);
    return { pastPaperWeakTopics, syllabusWeakTopics };
  }

  private async pastPaperWeakness(
    userId: string,
    subjectId: string | undefined,
    order: 'ASC' | 'DESC' = 'ASC',
  ): Promise<PastPaperWeakTopic[]> {
    const qb = this.answersRepo
      .createQueryBuilder('a')
      .innerJoin(Question, 'q', 'q.id = a.question_id')
      .innerJoin(Topic, 't', 't.id = q.topic_id')
      .innerJoin(Subject, 'subj', 'subj.id = t.subject_id')
      .innerJoin('a.exam', 'e', 'e.user_id = :uid', { uid: userId })
      .where('a.question_pool = :pp', { pp: QuestionPool.PAST_PAPER })
      .andWhere('a.answered_at IS NOT NULL')
      .andWhere('q.topic_id IS NOT NULL')
      .select('q.topic_id', 'topicId')
      .addSelect('t.title', 'title')
      .addSelect('subj.id', 'subjectId')
      .addSelect('subj.name', 'subjectName')
      .addSelect('COUNT(a.id)::int', 'answered')
      .addSelect(
        'SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END)::int',
        'correct',
      )
      .groupBy('q.topic_id')
      .addGroupBy('t.title')
      .addGroupBy('subj.id')
      .addGroupBy('subj.name')
      .having(`COUNT(a.id) >= ${MIN_SAMPLES}`)
      .orderBy(
        `SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END)::float / COUNT(a.id)`,
        order,
      )
      .limit(TOP_N);
    if (subjectId) {
      qb.andWhere('q.subject_id = :sid', { sid: subjectId });
    }
    const rows = await qb.getRawMany<{
      topicId: string;
      title: string;
      subjectId: string;
      subjectName: string;
      answered: number;
      correct: number;
    }>();
    return rows.map((r) => ({
      topicId: r.topicId,
      title: r.title,
      subjectId: r.subjectId,
      subjectName: r.subjectName,
      answered: r.answered,
      correct: r.correct,
      accuracy: r.answered > 0 ? r.correct / r.answered : 0,
    }));
  }

  private async syllabusWeakness(
    userId: string,
    subjectId: string | undefined,
    order: 'ASC' | 'DESC' = 'ASC',
  ): Promise<SyllabusWeakTopic[]> {
    const qb = this.answersRepo
      .createQueryBuilder('a')
      .innerJoin(PmTestQuestion, 'q', 'q.id = a.question_id')
      .innerJoin(SyllabusTopic, 's', 's.id = q.syllabus_topic_id')
      .innerJoin(Subject, 'subj', 'subj.id = s.subject_id')
      .innerJoin('a.exam', 'e', 'e.user_id = :uid', { uid: userId })
      .where('a.question_pool = :pt', { pt: QuestionPool.PM_TEST })
      .andWhere('a.answered_at IS NOT NULL')
      .andWhere('q.syllabus_topic_id IS NOT NULL')
      .select('q.syllabus_topic_id', 'syllabusTopicId')
      .addSelect('s.title', 'title')
      .addSelect('subj.id', 'subjectId')
      .addSelect('subj.name', 'subjectName')
      .addSelect('q.form_level', 'formLevel')
      .addSelect('COUNT(a.id)::int', 'answered')
      .addSelect(
        'SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END)::int',
        'correct',
      )
      .groupBy('q.syllabus_topic_id')
      .addGroupBy('s.title')
      .addGroupBy('subj.id')
      .addGroupBy('subj.name')
      .addGroupBy('q.form_level')
      .having(`COUNT(a.id) >= ${MIN_SAMPLES}`)
      .orderBy(
        `SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END)::float / COUNT(a.id)`,
        order,
      )
      .limit(TOP_N);
    if (subjectId) {
      qb.andWhere('q.subject_id = :sid', { sid: subjectId });
    }
    const rows = await qb.getRawMany<{
      syllabusTopicId: string;
      title: string;
      subjectId: string;
      subjectName: string;
      formLevel: number | null;
      answered: number;
      correct: number;
    }>();
    return rows.map((r) => ({
      syllabusTopicId: r.syllabusTopicId,
      title: r.title,
      subjectId: r.subjectId,
      subjectName: r.subjectName,
      formLevel: r.formLevel,
      answered: r.answered,
      correct: r.correct,
      accuracy: r.answered > 0 ? r.correct / r.answered : 0,
    }));
  }
}
