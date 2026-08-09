import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subject } from './entities/subject.entity';
import { Topic } from './entities/topic.entity';
import { Question } from '../questions/entities/question.entity';
import { ExamType, QuestionStatus } from '../../common/types/enums';
import { RedisService } from '../../common/redis/redis.service';
import { CacheKeys } from '../../common/utils/cache-keys.util';
import {
  CreateSubjectDto,
  CreateTopicDto,
  UpdateSubjectDto,
  UpdateTopicDto,
} from './dto/create-subject.dto';

const SUBJECTS_CACHE_TTL_SECONDS = 3600;

export interface SubjectWithCounts extends Subject {
  topicCount: number;
  questionCount: number;
}

@Injectable()
export class SubjectsService {
  constructor(
    @InjectRepository(Subject)
    private readonly subjectsRepo: Repository<Subject>,
    @InjectRepository(Topic) private readonly topicsRepo: Repository<Topic>,
    @InjectRepository(Question)
    private readonly questionsRepo: Repository<Question>,
    private readonly redis: RedisService,
  ) {}

  async listActive(
    examType?: ExamType,
    opts: { includeInactive?: boolean } = {},
  ): Promise<SubjectWithCounts[]> {
    // includeInactive bypasses Redis — admins editing visibility need
    // immediate feedback, and the cached payload is the public
    // active-only view we don't want to pollute.
    const cacheKey = examType
      ? `${CacheKeys.subjectsAll()}:${examType}`
      : CacheKeys.subjectsAll();
    if (!opts.includeInactive) {
      const cached = await this.redis.getJson<SubjectWithCounts[]>(cacheKey);
      if (cached) return cached;
    }

    const qb = this.subjectsRepo
      .createQueryBuilder('s')
      .loadRelationCountAndMap('s.topicCount', 's.topics');
    if (!opts.includeInactive) {
      qb.where('s.isActive = true');
    }
    if (examType) {
      qb.andWhere('s.examType = :examType', { examType });
    }
    qb.orderBy('s.sortOrder', 'ASC');
    const rows = await qb.getMany();

    const countsQb = this.questionsRepo
      .createQueryBuilder('q')
      .select('q.subject_id', 'subjectId')
      .addSelect('COUNT(*)', 'count')
      .where('q.status = :status', { status: QuestionStatus.ACTIVE });
    if (examType) {
      countsQb.andWhere('q.exam_type = :examType', { examType });
    }
    const questionCounts = await countsQb
      .groupBy('q.subject_id')
      .getRawMany<{ subjectId: string; count: string }>();

    const countBySubject = new Map(
      questionCounts.map((r) => [r.subjectId, parseInt(r.count, 10)]),
    );
    const enriched = rows.map((s) => ({
      ...s,
      questionCount: countBySubject.get(s.id) ?? 0,
    })) as SubjectWithCounts[];

    if (!opts.includeInactive) {
      await this.redis.setJson(cacheKey, enriched, SUBJECTS_CACHE_TTL_SECONDS);
    }
    return enriched;
  }

  async getById(id: string): Promise<Subject> {
    const s = await this.subjectsRepo.findOne({
      where: { id },
      relations: ['topics'],
    });
    if (!s) throw new NotFoundException('Subject not found');
    return s;
  }

  async getTopics(
    subjectId: string,
  ): Promise<Array<Topic & { questionCount: number }>> {
    const topics = await this.topicsRepo.find({
      where: { subjectId },
      order: { sortOrder: 'ASC' },
    });
    if (topics.length === 0) return [];

    const rows = await this.questionsRepo
      .createQueryBuilder('q')
      .select('q.topic_id', 'topicId')
      .addSelect('COUNT(*)', 'count')
      .where('q.topic_id IN (:...ids)', { ids: topics.map((t) => t.id) })
      .andWhere('q.status = :status', { status: QuestionStatus.ACTIVE })
      .groupBy('q.topic_id')
      .getRawMany<{ topicId: string; count: string }>();

    const countByTopic = new Map(
      rows.map((r) => [r.topicId, parseInt(r.count, 10)]),
    );
    return topics.map((t) => ({
      ...t,
      questionCount: countByTopic.get(t.id) ?? 0,
    }));
  }

  async create(dto: CreateSubjectDto): Promise<Subject> {
    const s = this.subjectsRepo.create(dto);
    await this.subjectsRepo.save(s);
    await this.invalidateCache();
    return s;
  }

  async update(id: string, dto: UpdateSubjectDto): Promise<Subject> {
    const s = await this.subjectsRepo.findOne({ where: { id } });
    if (!s) throw new NotFoundException('Subject not found');
    Object.assign(s, dto);
    await this.subjectsRepo.save(s);
    await this.invalidateCache();
    return s;
  }

  async createTopic(subjectId: string, dto: CreateTopicDto): Promise<Topic> {
    const subject = await this.subjectsRepo.findOne({
      where: { id: subjectId },
    });
    if (!subject) throw new NotFoundException('Subject not found');
    const topic = this.topicsRepo.create({ ...dto, subjectId });
    await this.topicsRepo.save(topic);
    await this.invalidateCache();
    return topic;
  }

  async updateTopic(topicId: string, dto: UpdateTopicDto): Promise<Topic> {
    const topic = await this.topicsRepo.findOne({ where: { id: topicId } });
    if (!topic) throw new NotFoundException('Topic not found');
    Object.assign(topic, dto);
    await this.topicsRepo.save(topic);
    await this.invalidateCache();
    return topic;
  }

  /**
   * Soft-delete a subject (sets `deleted_at`). The row stays in the
   * DB so existing questions tagged with this subject continue to
   * resolve; the public listing filters it out via the
   * @DeleteDateColumn convention. To fully remove a subject the
   * admin must first re-tag or delete every question that
   * references it.
   */
  async softDelete(id: string): Promise<void> {
    const s = await this.subjectsRepo.findOne({ where: { id } });
    if (!s) throw new NotFoundException('Subject not found');
    await this.subjectsRepo.softRemove(s);
    await this.invalidateCache();
  }

  async softDeleteTopic(topicId: string): Promise<void> {
    const t = await this.topicsRepo.findOne({ where: { id: topicId } });
    if (!t) throw new NotFoundException('Topic not found');
    await this.topicsRepo.softRemove(t);
    await this.invalidateCache();
  }

  async invalidateCache(): Promise<void> {
    const base = CacheKeys.subjectsAll();
    await Promise.all([
      this.redis.del(base),
      this.redis.del(`${base}:${ExamType.BECE}`),
      this.redis.del(`${base}:${ExamType.WASSCE}`),
    ]);
  }
}
