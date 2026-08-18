import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PmTestQuestion } from './entities/pm-test-question.entity';
import { PmTestOption } from './entities/pm-test-option.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { User } from '../users/entities/user.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import {
  ExamType,
  QuestionPool,
  QuestionStatus,
  questionPoolFor,
} from '../../common/types/enums';
import {
  StudentPmTestQuestion,
  toStudentPmTestQuestion,
} from './serializers/pm-test.serializer';

export interface PmTestSubjectRow {
  subjectId: string;
  subjectName: string;
  iconSlug: string | null;
  activeQuestionCount: number;
  lastAttemptedAt: string | null;
  accuracy: number | null;
}

export interface PmTestSubjectStat {
  subjectId: string;
  subjectName: string;
  answered: number;
  correct: number;
  accuracy: number;
}

@Injectable()
export class PmTestService {
  constructor(
    @InjectRepository(PmTestQuestion)
    private readonly qRepo: Repository<PmTestQuestion>,
    @InjectRepository(PmTestOption)
    private readonly oRepo: Repository<PmTestOption>,
    @InjectRepository(Subject)
    private readonly subjectsRepo: Repository<Subject>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(ExamAnswer)
    private readonly answersRepo: Repository<ExamAnswer>,
  ) {}

  /**
   * Subjects that have at least one active PM Test question for the user's
   * (examType, formLevel) combo. Drives the subject picker on the mobile
   * Bondzi Test screen.
   */
  async listSubjectsForUser(userId: string): Promise<PmTestSubjectRow[]> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    // NOVDEC reuses the WASSCE PM Test pool — they study the same syllabus.
    const examType = questionPoolFor(user.examType);
    const formLevel = user.formLevel;

    // One query for question counts, another for the user's per-subject
    // Bondzi Test performance. Merged in code because the two shapes
    // fan out differently — subjects with zero attempts still appear in
    // the counts result, but wouldn't survive an INNER JOIN into
    // exam_answers.
    const counts = await this.listSubjects(examType, formLevel);
    const stats = await this.attemptStatsForUser(userId, examType);
    const statBySubject = new Map(stats.map((s) => [s.subjectId, s]));

    return counts.map((c) => {
      const s = statBySubject.get(c.subjectId);
      return {
        subjectId: c.subjectId,
        subjectName: c.subjectName,
        iconSlug: null,
        activeQuestionCount: c.activeQuestionCount,
        lastAttemptedAt: s?.lastAttemptedAt ?? null,
        accuracy: s?.accuracy ?? null,
      };
    });
  }

  /**
   * Internal count-only variant used by listSubjectsForUser and by admin
   * previews. Doesn't join into exam_answers so it stays cheap.
   */
  async listSubjects(
    examType: ExamType,
    formLevel: number | null,
  ): Promise<
    Array<{
      subjectId: string;
      subjectName: string;
      activeQuestionCount: number;
    }>
  > {
    // Remedial (NOVDEC) users have NULL form_level — they sit WASSCE re-sits
    // as private candidates so they aren't bound to a school form. Skip the
    // form-level filter for them.
    const qb = this.qRepo
      .createQueryBuilder('q')
      .innerJoin(Subject, 's', 's.id = q.subject_id')
      .select('s.id', 'subjectId')
      .addSelect('s.name', 'subjectName')
      .addSelect('COUNT(q.id)', 'activeQuestionCount')
      .where('q.exam_type = :et', { et: examType })
      .andWhere('q.status = :st', { st: QuestionStatus.ACTIVE });
    if (formLevel != null) {
      qb.andWhere('q.form_level = :fl', { fl: formLevel });
    }
    const rows = await qb
      .groupBy('s.id')
      .addGroupBy('s.name')
      .orderBy('s.name', 'ASC')
      .getRawMany<{
        subjectId: string;
        subjectName: string;
        activeQuestionCount: string;
      }>();

    return rows.map((r) => ({
      subjectId: r.subjectId,
      subjectName: r.subjectName,
      activeQuestionCount: parseInt(r.activeQuestionCount, 10) || 0,
    }));
  }

  /**
   * Per-subject Bondzi-Test attempt stats for one user — accuracy as a
   * 0..1 fraction plus the most recent attempt timestamp. Only returns
   * subjects the user has actually answered at least once.
   */
  private async attemptStatsForUser(
    userId: string,
    examType: ExamType,
  ): Promise<
    Array<{ subjectId: string; accuracy: number; lastAttemptedAt: string }>
  > {
    const rows = await this.answersRepo
      .createQueryBuilder('a')
      .innerJoin(
        PmTestQuestion,
        'q',
        'q.id = a.question_id AND a.question_pool = :pool AND q.exam_type = :et',
        { pool: QuestionPool.PM_TEST, et: examType },
      )
      .innerJoin('a.exam', 'e', 'e.user_id = :uid', { uid: userId })
      .select('q.subject_id', 'subjectId')
      .addSelect('COUNT(a.id)', 'answered')
      .addSelect('SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END)', 'correct')
      .addSelect('MAX(a.answered_at)', 'lastAttemptedAt')
      .groupBy('q.subject_id')
      .getRawMany<{
        subjectId: string;
        answered: string;
        correct: string;
        lastAttemptedAt: string | Date | null;
      }>();

    return rows
      .filter((r) => r.lastAttemptedAt)
      .map((r) => {
        const answered = parseInt(r.answered, 10) || 0;
        const correct = parseInt(r.correct, 10) || 0;
        const last =
          r.lastAttemptedAt instanceof Date
            ? r.lastAttemptedAt.toISOString()
            : String(r.lastAttemptedAt);
        return {
          subjectId: r.subjectId,
          accuracy: answered > 0 ? correct / answered : 0,
          lastAttemptedAt: last,
        };
      });
  }

  /**
   * Fetch a randomised, active PM Test question set for the user. `formLevel`
   * defaults to the user's profile; override allowed if the admin/QA wants to
   * preview another level.
   */
  async listQuestions(
    userId: string,
    params: {
      subjectId: string;
      formLevel?: number;
      limit?: number;
    },
  ): Promise<StudentPmTestQuestion[]> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const formLevel = params.formLevel ?? user.formLevel;
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));

    const qb = this.qRepo
      .createQueryBuilder('q')
      .leftJoinAndSelect('q.options', 'o')
      // NOVDEC → WASSCE pool remap (PM Test questions aren't tagged novdec).
      .where('q.exam_type = :et', { et: questionPoolFor(user.examType) })
      .andWhere('q.subject_id = :sid', { sid: params.subjectId })
      .andWhere('q.status = :st', { st: QuestionStatus.ACTIVE });
    if (formLevel != null) {
      qb.andWhere('q.form_level = :fl', { fl: formLevel });
    }
    const rows = await qb.orderBy('random()').limit(limit).getMany();

    if (rows.length === 0) {
      throw new BadRequestException(
        'No PM Test questions available for this combo yet.',
      );
    }
    return rows.map(toStudentPmTestQuestion);
  }

  /** Per-subject PM Test performance for the user. Drives the Stats screen. */
  async statsForUser(userId: string): Promise<PmTestSubjectStat[]> {
    // LEFT JOIN exam_answers -> pm_test_questions via question_id.
    const rows = await this.answersRepo
      .createQueryBuilder('a')
      .innerJoin(
        PmTestQuestion,
        'q',
        'q.id = a.question_id AND a.question_pool = :pool',
        { pool: QuestionPool.PM_TEST },
      )
      .innerJoin('a.exam', 'e', 'e.user_id = :uid', { uid: userId })
      .innerJoin(Subject, 's', 's.id = q.subject_id')
      .select('s.id', 'subjectId')
      .addSelect('s.name', 'subjectName')
      .addSelect('COUNT(a.id)', 'answered')
      .addSelect('SUM(CASE WHEN a.is_correct THEN 1 ELSE 0 END)', 'correct')
      .groupBy('s.id')
      .addGroupBy('s.name')
      .getRawMany<{
        subjectId: string;
        subjectName: string;
        answered: string;
        correct: string;
      }>();

    return rows.map((r) => {
      const answered = parseInt(r.answered, 10) || 0;
      const correct = parseInt(r.correct, 10) || 0;
      return {
        subjectId: r.subjectId,
        subjectName: r.subjectName,
        answered,
        correct,
        accuracy: answered > 0 ? correct / answered : 0,
      };
    });
  }

  /**
   * Fetch a single PM Test question for the exam engine (server-side answer
   * checking). Deliberately includes is_correct for internal use only.
   */
  async findForGradingUnsafe(id: string): Promise<PmTestQuestion | null> {
    return this.qRepo.findOne({ where: { id }, relations: ['options'] });
  }

  correctOption(options: PmTestOption[]): PmTestOption | undefined {
    return options.find((o) => o.isCorrect);
  }

  optionsRepo(): Repository<PmTestOption> {
    return this.oRepo;
  }
}
