import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { sanitizeHtml } from '../../common/utils/sanitize.util';
import { markdownToHtml } from '../../common/utils/math.util';
import { AuditLog } from '../admin/entities/audit-log.entity';
import { Question } from './entities/question.entity';
import { QuestionStimulus } from './entities/question-stimulus.entity';
import { CreateStimulusDto, UpdateStimulusDto } from './dto/stimulus.dto';

export interface StimulusWithUsage extends QuestionStimulus {
  /** Count of questions referencing this stimulus — surfaced in the admin list. */
  questionCount: number;
}

@Injectable()
export class StimuliService {
  private readonly logger = new Logger(StimuliService.name);

  constructor(
    @InjectRepository(QuestionStimulus)
    private readonly stimuliRepo: Repository<QuestionStimulus>,
    @InjectRepository(Question)
    private readonly questionsRepo: Repository<Question>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
  ) {}

  async list(options?: {
    search?: string;
    limit?: number;
  }): Promise<StimulusWithUsage[]> {
    const limit = Math.min(200, Math.max(1, options?.limit ?? 100));
    const qb = this.stimuliRepo
      .createQueryBuilder('s')
      .leftJoin(Question, 'q', 'q.stimulus_id = s.id')
      .addSelect('COUNT(q.id)', 's_question_count')
      .groupBy('s.id')
      .orderBy('s.created_at', 'DESC')
      .limit(limit);

    if (options?.search?.trim()) {
      const needle = `%${options.search.trim()}%`;
      qb.andWhere('(s.title ILIKE :needle OR s.body ILIKE :needle)', {
        needle,
      });
    }

    const { entities, raw } = await qb.getRawAndEntities<{
      s_question_count: string;
    }>();
    return entities.map((s, i) => ({
      ...s,
      questionCount: Number(raw[i]?.s_question_count ?? 0),
    }));
  }

  async getById(id: string): Promise<QuestionStimulus> {
    const stimulus = await this.stimuliRepo.findOne({ where: { id } });
    if (!stimulus) throw new NotFoundException('Stimulus not found');
    return stimulus;
  }

  async create(
    adminId: string,
    dto: CreateStimulusDto,
  ): Promise<QuestionStimulus> {
    const created = this.stimuliRepo.create({
      title: dto.title?.trim() || null,
      body: dto.body,
      bodyHtml: sanitizeHtml(markdownToHtml(dto.body)),
      imageUrl: dto.imageUrl ?? null,
      createdBy: adminId,
    });
    const saved = await this.stimuliRepo.save(created);
    await this.writeAudit(adminId, 'question_stimulus.create', saved.id, {
      oldValue: null,
      newValue: this.snapshot(saved),
    });
    return saved;
  }

  async update(
    adminId: string,
    id: string,
    dto: UpdateStimulusDto,
  ): Promise<QuestionStimulus> {
    const stimulus = await this.getById(id);
    const before = this.snapshot(stimulus);

    if (dto.title !== undefined) {
      stimulus.title = dto.title.trim() || null;
    }
    if (dto.body !== undefined) {
      stimulus.body = dto.body;
      stimulus.bodyHtml = sanitizeHtml(markdownToHtml(dto.body));
    }
    if (dto.imageUrl !== undefined) {
      stimulus.imageUrl = dto.imageUrl || null;
    }

    const saved = await this.stimuliRepo.save(stimulus);
    await this.writeAudit(adminId, 'question_stimulus.update', id, {
      oldValue: before,
      newValue: this.snapshot(saved),
    });
    return saved;
  }

  /**
   * Deletes a stimulus only when no questions reference it. Returning a
   * specific 409 (with the count) lets the admin UI nudge the user to
   * detach those questions first rather than silently null-cascading the
   * FK and confusing students mid-session.
   */
  async delete(adminId: string, id: string): Promise<{ deleted: true }> {
    const stimulus = await this.getById(id);
    const usageCount = await this.questionsRepo.count({
      where: { stimulusId: id },
    });
    if (usageCount > 0) {
      throw new ConflictException(
        `Cannot delete: ${usageCount} question${usageCount === 1 ? '' : 's'} still reference this stimulus.`,
      );
    }
    const before = this.snapshot(stimulus);
    await this.stimuliRepo.delete(id);
    await this.writeAudit(adminId, 'question_stimulus.delete', id, {
      oldValue: before,
      newValue: { deleted: true },
    });
    return { deleted: true };
  }

  /** Used by question create/update DTOs to validate `stimulusId` references. */
  async assertExists(id: string): Promise<void> {
    const exists = await this.stimuliRepo.findOne({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException(`Stimulus ${id} does not exist.`);
    }
  }

  // --- Internals -----------------------------------------------------------

  private snapshot(s: QuestionStimulus): Record<string, unknown> {
    return {
      id: s.id,
      title: s.title,
      body: s.body,
      imageUrl: s.imageUrl,
    };
  }

  private async writeAudit(
    adminId: string,
    action: string,
    entityId: string,
    values: {
      oldValue: Record<string, unknown> | null;
      newValue: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.auditRepo.save(
        this.auditRepo.create({
          adminId,
          action,
          entityType: 'question_stimulus',
          entityId,
          oldValue: values.oldValue,
          newValue: values.newValue,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `audit_log insert for ${action} failed: ${(err as Error).message}`,
      );
    }
  }
}
