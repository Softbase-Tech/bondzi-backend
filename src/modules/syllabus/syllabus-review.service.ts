import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SyllabusIndicator,
  SyllabusIndicatorStatus,
} from './entities/syllabus-indicator.entity';
import { PaginatedResult } from '../../common/dto/pagination.dto';

export interface SyllabusIndicatorRow {
  id: string;
  code: string;
  statement: string;
  workedContent: string | null;
  targetDokLevels: number[] | null;
  status: SyllabusIndicatorStatus;
  formLevel: number;
  subjectId: string;
  contentStandardCode: string;
  isEmbedded: boolean;
}

/**
 * Admin review of extracted indicators: browse the `draft` queue, edit a
 * statement/worked-content, and approve (approval makes an indicator eligible
 * for embedding + generation grounding).
 */
@Injectable()
export class SyllabusReviewService {
  constructor(
    @InjectRepository(SyllabusIndicator)
    private readonly indicators: Repository<SyllabusIndicator>,
  ) {}

  async list(opts: {
    subjectId?: string;
    status?: SyllabusIndicatorStatus;
    page: number;
    limit: number;
  }): Promise<PaginatedResult<SyllabusIndicatorRow>> {
    const qb = this.indicators
      .createQueryBuilder('i')
      .innerJoin('i.contentStandard', 'cs')
      .orderBy('i.subjectId', 'ASC')
      .addOrderBy('i.formLevel', 'ASC')
      .addOrderBy('i.code', 'ASC')
      .take(opts.limit)
      .skip((opts.page - 1) * opts.limit);
    if (opts.subjectId) qb.andWhere('i.subjectId = :s', { s: opts.subjectId });
    if (opts.status) qb.andWhere('i.status = :st', { st: opts.status });
    qb.select([
      'i.id AS id',
      'i.code AS code',
      'i.statement AS statement',
      'i.worked_content AS "workedContent"',
      'i.target_dok_levels AS "targetDokLevels"',
      'i.status AS status',
      'i.form_level AS "formLevel"',
      'i.subject_id AS "subjectId"',
      'cs.code AS "contentStandardCode"',
      '(i.embedding IS NOT NULL) AS "isEmbedded"',
    ]);

    const [rows, total] = await Promise.all([
      qb.getRawMany<SyllabusIndicatorRow>(),
      this.countFor(opts.subjectId, opts.status),
    ]);
    return { items: rows, total };
  }

  private countFor(
    subjectId?: string,
    status?: SyllabusIndicatorStatus,
  ): Promise<number> {
    const qb = this.indicators.createQueryBuilder('i');
    if (subjectId) qb.andWhere('i.subjectId = :s', { s: subjectId });
    if (status) qb.andWhere('i.status = :st', { st: status });
    return qb.getCount();
  }

  async update(
    id: string,
    patch: {
      status?: SyllabusIndicatorStatus;
      statement?: string;
      workedContent?: string | null;
      targetDokLevels?: number[] | null;
    },
  ): Promise<SyllabusIndicator> {
    const row = await this.indicators.findOne({ where: { id } });
    if (!row) throw new BadRequestException('Indicator not found.');
    if (patch.status) row.status = patch.status;
    if (patch.statement !== undefined) row.statement = patch.statement;
    if (patch.workedContent !== undefined)
      row.workedContent = patch.workedContent;
    if (patch.targetDokLevels !== undefined) {
      row.targetDokLevels = patch.targetDokLevels;
    }
    // An edit invalidates any existing vector — clear it so the next embed
    // pass re-embeds from the corrected text.
    if (patch.statement !== undefined || patch.workedContent !== undefined) {
      row.embeddingModel = null;
      row.embeddedAt = null;
    }
    return this.indicators.save(row);
  }

  /**
   * Bulk-approve every `draft` indicator, optionally scoped to one subject.
   * Mirrors the "Embed approved" bulk action so a reviewer can clear a whole
   * subject's queue in one click instead of row by row. Already-approved rows
   * are untouched. Returns how many drafts were flipped.
   */
  async approveAll(opts: {
    subjectId?: string;
  }): Promise<{ approved: number }> {
    const qb = this.indicators
      .createQueryBuilder()
      .update(SyllabusIndicator)
      .set({ status: 'approved' })
      .where('status = :draft', { draft: 'draft' });
    if (opts.subjectId) {
      qb.andWhere('subject_id = :sid', { sid: opts.subjectId });
    }
    const res = await qb.execute();
    return { approved: res.affected ?? 0 };
  }

  /** Per-subject draft/approved/embedded counts for the coverage view. */
  async summary(): Promise<
    Array<{ subjectId: string; draft: number; approved: number }>
  > {
    const rows: Array<{ subjectId: string; status: string; n: string }> =
      await this.indicators
        .createQueryBuilder('i')
        .select('i.subject_id', 'subjectId')
        .addSelect('i.status', 'status')
        .addSelect('COUNT(*)', 'n')
        .groupBy('i.subject_id')
        .addGroupBy('i.status')
        .getRawMany();
    const map = new Map<
      string,
      { subjectId: string; draft: number; approved: number }
    >();
    for (const r of rows) {
      const e = map.get(r.subjectId) ?? {
        subjectId: r.subjectId,
        draft: 0,
        approved: 0,
      };
      if (r.status === 'approved') e.approved = Number(r.n);
      else e.draft = Number(r.n);
      map.set(r.subjectId, e);
    }
    return [...map.values()];
  }
}
