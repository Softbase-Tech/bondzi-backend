import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { SrsCard } from './entities/srs-card.entity';
import { Question } from '../questions/entities/question.entity';
import { sm2 } from './utils/sm2.util';
import {
  toStudentQuestion,
  StudentQuestion,
} from '../questions/serializers/question.serializer';

export interface SrsDuePayload {
  questionId: string;
  question: StudentQuestion;
  dueAt: string;
  interval: number;
  easeFactor: number;
}
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';

@Injectable()
export class SrsService {
  constructor(
    @InjectRepository(SrsCard) private readonly cardsRepo: Repository<SrsCard>,
    @InjectRepository(Question)
    private readonly questionsRepo: Repository<Question>,
    private readonly redis: RedisService,
  ) {}

  async getDue(userId: string, subjectId?: string): Promise<SrsDuePayload[]> {
    const qb = this.cardsRepo
      .createQueryBuilder('c')
      .innerJoinAndSelect('c.question', 'q')
      .leftJoinAndSelect('q.options', 'o')
      .leftJoinAndSelect('q.stimulus', 's')
      .where('c.userId = :userId', { userId })
      // Match /srs/stats' dueToday window — anything releasing today counts,
      // not just cards released by `now()`. Otherwise the home-screen count
      // and the review queue can disagree.
      .andWhere('c.nextReviewAt <= :endOfToday', {
        endOfToday: endOfDay(new Date()),
      })
      .andWhere("q.status = 'active'")
      .orderBy('c.nextReviewAt', 'ASC');

    if (subjectId) qb.andWhere('q.subjectId = :sid', { sid: subjectId });
    const cards = await qb.limit(50).getMany();
    // The mobile contract (mobile/lib/validators/index.ts SrsDueSchema) is an
    // envelope per card, not a flat StudentQuestion. The embedded question
    // carries `options`; without that wrapper the review screen treats every
    // card as malformed and shows "All caught up!".
    return cards.map((c) => ({
      questionId: c.questionId,
      question: toStudentQuestion(c.question),
      dueAt: c.nextReviewAt.toISOString(),
      interval: c.intervalDays,
      easeFactor: Number(c.easeFactor),
    }));
  }

  async review(
    userId: string,
    questionId: string,
    quality: number,
  ): Promise<SrsCard> {
    let card = await this.cardsRepo.findOne({ where: { userId, questionId } });
    if (!card) {
      const question = await this.questionsRepo.findOne({
        where: { id: questionId },
      });
      if (!question) throw new NotFoundException('Question not found');
      card = this.cardsRepo.create({ userId, questionId });
    }

    const next = sm2(quality, {
      easeFactor: card.easeFactor,
      intervalDays: card.intervalDays,
      repetitions: card.repetitions,
    });
    card.easeFactor = next.easeFactor;
    card.intervalDays = next.intervalDays;
    card.repetitions = next.repetitions;
    card.lastQuality = next.lastQuality;
    card.nextReviewAt = next.nextReviewAt;
    card.lastReviewedAt = next.lastReviewedAt;

    await this.cardsRepo.save(card);
    await this.redis.del(CacheKeys.srsDueCount(userId));
    return card;
  }

  async upsertFromAnswer(
    userId: string,
    questionId: string,
    isCorrect: boolean,
  ): Promise<void> {
    // Simplified quality mapping — spec §5.5 says full scoring is Phase 2.
    const quality = isCorrect ? 4 : 1;
    await this.review(userId, questionId, quality);
  }

  async stats(userId: string) {
    const cached = await this.redis.get(CacheKeys.srsDueCount(userId));
    const now = new Date();
    const [total, dueToday, overdue, mastered] = await Promise.all([
      this.cardsRepo.count({ where: { userId } }),
      this.cardsRepo.count({
        where: { userId, nextReviewAt: LessThanOrEqual(endOfDay(now)) },
      }),
      this.cardsRepo.count({
        where: { userId, nextReviewAt: LessThanOrEqual(startOfDay(now)) },
      }),
      this.cardsRepo
        .createQueryBuilder('c')
        .where('c.userId = :uid', { uid: userId })
        .andWhere('c.intervalDays > 21')
        .getCount(),
    ]);

    const stats = { total, dueToday, overdue, mastered };
    if (!cached) {
      await this.redis.setJson(
        CacheKeys.srsDueCount(userId),
        dueToday,
        30 * 60,
      );
    }
    return stats;
  }
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
