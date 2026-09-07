import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { SyllabusTopic } from './entities/syllabus-topic.entity';
import { Subject } from './entities/subject.entity';
import { ExamType } from '../../common/types/enums';
import {
  CreateSyllabusTopicDto,
  UpdateSyllabusTopicDto,
} from './dto/syllabus-topic.dto';

export interface BulkImportSummary {
  submitted: number;
  inserted: number;
  updated: number;
  /**
   * Items that failed schema-level checks before insert (e.g. subject
   * does not exist, form level out of bounds). The service returns
   * the whole batch's result rather than aborting on first failure,
   * so an operator pasting 200 rows sees every problem in one pass.
   */
  rejected: Array<{
    index: number;
    reason: string;
    item: CreateSyllabusTopicDto;
  }>;
}

/**
 * Owns the syllabus-topics catalogue. Two consumer patterns:
 *
 *   1. Read: student mobile + admin PM-Test generation picker call
 *      `list({ examType?, subjectId?, formLevel? })`. Only active rows.
 *
 *   2. Write: admin edits one at a time OR bulk-imports a whole
 *      subject × form. Bulk-import is idempotent via the partial
 *      unique index on (subject, exam_type, form_level, title) where
 *      is_active=true — re-pasting the same spreadsheet refreshes
 *      description/sortOrder without duplicates.
 *
 * Soft-delete via `isActive=false` (matches the entity default). Hard
 * delete is deliberately not exposed — a syllabus topic may be
 * referenced by `pm_test_questions.syllabus_topic_id` (FK, SET NULL
 * on delete) and by student progress rows once the weakness rollup
 * lands; soft-delete lets us keep the historical linkage.
 */
@Injectable()
export class SyllabusTopicsService {
  private readonly logger = new Logger(SyllabusTopicsService.name);

  constructor(
    @InjectRepository(SyllabusTopic)
    private readonly repo: Repository<SyllabusTopic>,
    @InjectRepository(Subject)
    private readonly subjectsRepo: Repository<Subject>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  // ------------------------- consumer read -------------------------

  /**
   * Filtered list of active syllabus topics, sorted by (sortOrder,
   * title) so admin-authored ordering wins but ties fall back to
   * alphabetical. When every filter is set (examType + subjectId +
   * formLevel), this is what the PM-Test generation picker and the
   * mobile Level-Test setup screen call.
   */
  async list(filters: {
    examType?: ExamType;
    subjectId?: string;
    formLevel?: number;
  }): Promise<SyllabusTopic[]> {
    const qb = this.repo
      .createQueryBuilder('st')
      .where('st.is_active = true')
      .orderBy('st.sort_order', 'ASC')
      .addOrderBy('st.title', 'ASC');
    if (filters.examType) {
      qb.andWhere('st.exam_type = :et', { et: filters.examType });
    }
    if (filters.subjectId) {
      qb.andWhere('st.subject_id = :sid', { sid: filters.subjectId });
    }
    if (filters.formLevel != null) {
      qb.andWhere('st.form_level = :fl', { fl: filters.formLevel });
    }
    return qb.getMany();
  }

  // ------------------------- admin write -------------------------

  async create(dto: CreateSyllabusTopicDto): Promise<SyllabusTopic> {
    await this.assertSubjectExists(dto.subjectId, dto.examType);
    const row = this.repo.create({
      subjectId: dto.subjectId,
      examType: dto.examType,
      formLevel: dto.formLevel,
      title: dto.title.trim(),
      description: dto.description?.trim() || null,
      sortOrder: dto.sortOrder ?? 0,
      isActive: true,
    });
    try {
      return await this.repo.save(row);
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (message.includes('uq_syllabus_topics_active')) {
        throw new BadRequestException(
          `A syllabus topic titled "${dto.title}" already exists for this subject/exam/form.`,
        );
      }
      throw err;
    }
  }

  async update(
    id: string,
    dto: UpdateSyllabusTopicDto,
  ): Promise<SyllabusTopic> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Syllabus topic not found');
    if (dto.title !== undefined && dto.title.trim() !== row.title) {
      row.title = dto.title.trim();
      // An admin-chosen title is a display label the sync refresh must
      // never revert to the CS statement.
      row.isTitleCustom = true;
    }
    if (dto.description !== undefined) {
      row.description = dto.description?.trim() || null;
    }
    if (dto.sortOrder !== undefined) row.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) row.isActive = dto.isActive;
    try {
      return await this.repo.save(row);
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (message.includes('uq_syllabus_topics_active')) {
        throw new BadRequestException(
          `Another active syllabus topic with title "${row.title}" already exists for this subject/exam/form.`,
        );
      }
      throw err;
    }
  }

  /**
   * Toggle isActive → false (soft delete). Hard delete is intentionally
   * absent — questions and progress rows may reference this row.
   */
  async softDelete(id: string): Promise<void> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Syllabus topic not found');
    if (!row.isActive) return; // already off, no-op
    row.isActive = false;
    await this.repo.save(row);
  }

  /**
   * Retitle a subject's bridged topics from the textbook section titles
   * of their linked learning-material chunks. The CS statement a topic
   * is born with ("Demonstrate knowledge and understanding of ...") is
   * a teacher objective; students recognise the textbook name for the
   * same material ("Nature and Functions of Accounting"), so once a
   * book is ingested and its chunks are topic-linked, this pass makes
   * the picker speak the book's language.
   *
   * Per topic: votes come from the topic's linked chunks, but only
   * those from its largest source book (by the book's total chunks for
   * the subject) — the main textbook names material better than a
   * single-topic booklet that also maps there. Within that book the
   * dominant sectionTitle wins. A retitled topic is marked
   * is_title_custom so the syllabus sync refresh never reverts it.
   * Skipped (and reported) when a topic has no linked chunks, when two
   * topics in the same form resolve to the same title (the one with
   * more chunks wins), or when the title is already taken by another
   * active topic.
   */
  async retitleFromMaterials(subjectId: string): Promise<{
    retitled: number;
    skippedNoMaterial: number;
    skippedDuplicate: number;
    skippedCollision: number;
    changes: Array<{ id: string; from: string; to: string }>;
  }> {
    const votes: Array<{
      id: string;
      title: string;
      form_level: number;
      sort_order: number;
      section_title: string;
      source_pdf: string;
      n: string;
      book_size: string;
    }> = await this.dataSource.query(
      `
      SELECT t.id, t.title, t.form_level, t.sort_order,
             c.section_title, c.source_pdf, count(*)::int AS n,
             (SELECT count(*) FROM learning_material_chunks b
               WHERE b.subject_id = $1 AND b.source_pdf = c.source_pdf
             )::int AS book_size
      FROM syllabus_topics t
      JOIN learning_material_chunks c ON c.syllabus_topic_id = t.id
      WHERE t.subject_id = $1 AND t.is_active = true
        AND c.section_title IS NOT NULL AND c.section_title <> ''
      GROUP BY t.id, t.title, t.form_level, t.sort_order,
               c.section_title, c.source_pdf
      ORDER BY t.form_level, t.sort_order
      `,
      [subjectId],
    );

    const allActive: Array<{ id: string; form_level: number; title: string }> =
      await this.dataSource.query(
        `SELECT id, form_level, title FROM syllabus_topics
          WHERE subject_id = $1 AND is_active = true`,
        [subjectId],
      );
    const totalTopics = new Set(allActive.map((t) => t.id)).size;

    // Per topic: prefer the biggest source book, then the dominant
    // section title within it.
    const best = new Map<
      string,
      {
        title: string;
        form: number;
        sort: number;
        to: string;
        n: number;
        bookSize: number;
      }
    >();
    for (const v of votes) {
      const cur = best.get(v.id);
      const bookSize = Number(v.book_size);
      const n = Number(v.n);
      if (
        !cur ||
        bookSize > cur.bookSize ||
        (bookSize === cur.bookSize && n > cur.n)
      ) {
        best.set(v.id, {
          title: v.title,
          form: v.form_level,
          sort: v.sort_order,
          to: v.section_title.trim(),
          n,
          bookSize,
        });
      }
    }

    let skippedDuplicate = 0;
    let skippedCollision = 0;
    const changes: Array<{ id: string; from: string; to: string }> = [];

    // Within one form, a proposed title may only be used once — the
    // topic with the most linked chunks (then lowest sortOrder) wins.
    const claimed = new Map<string, { id: string; n: number; sort: number }>();
    const entries = [...best.entries()].sort(
      (a, b) => b[1].n - a[1].n || a[1].sort - b[1].sort,
    );
    for (const [id, e] of entries) {
      if (e.to === e.title) continue; // already the book's name
      const key = `${e.form}::${e.to}`;
      if (claimed.has(key)) {
        skippedDuplicate += 1;
        continue;
      }
      const taken = allActive.some(
        (t) => t.id !== id && t.form_level === e.form && t.title === e.to,
      );
      if (taken) {
        skippedCollision += 1;
        continue;
      }
      claimed.set(key, { id, n: e.n, sort: e.sort });
      changes.push({ id, from: e.title, to: e.to });
    }

    for (const c of changes) {
      await this.dataSource.query(
        `UPDATE syllabus_topics
            SET title = $1, is_title_custom = true
          WHERE id = $2`,
        [c.to, c.id],
      );
    }

    const result = {
      retitled: changes.length,
      skippedNoMaterial: totalTopics - best.size,
      skippedDuplicate,
      skippedCollision,
      changes,
    };
    this.logger.log(
      `[syllabus-topics] retitle-from-materials subject=${subjectId}: ` +
        `${result.retitled} retitled, ${result.skippedNoMaterial} without material, ` +
        `${skippedDuplicate} duplicate titles, ${skippedCollision} collisions`,
    );
    return result;
  }

  // ------------------------- bulk import -------------------------

  /**
   * Idempotent bulk upsert. Splits the batch into two passes:
   *
   *   1. Preflight: every item validated against a fresh subject
   *      lookup (id exists + examType matches). Rejected items are
   *      collected, not thrown — the whole batch reports which rows
   *      failed so an operator can fix them in one edit cycle
   *      instead of chasing errors one at a time.
   *
   *   2. UPSERT: everything that passed preflight goes into one
   *      transaction with `ON CONFLICT ... DO UPDATE SET` on the
   *      (subject, exam_type, form_level, title) partial unique
   *      index — so re-importing the same spreadsheet refreshes
   *      description / sortOrder without duplicates, and net-new
   *      titles insert cleanly.
   *
   * The batch cap comes from ai.maxItemsPerBatch (same value the AI
   * generation surfaces use). Reusing that keeps ops with one
   * "batch size" ceiling to reason about instead of two.
   */
  async bulkImport(
    items: CreateSyllabusTopicDto[],
  ): Promise<BulkImportSummary> {
    if (items.length === 0) {
      return { submitted: 0, inserted: 0, updated: 0, rejected: [] };
    }
    const cap = this.config.get<number>('ai.maxItemsPerBatch') ?? 200;
    if (items.length > cap) {
      throw new BadRequestException(
        `Batch of ${items.length} items exceeds the per-batch cap (${cap}). Split the request or raise AI_MAX_ITEMS_PER_BATCH.`,
      );
    }

    // Preflight — pull every referenced subject in one query.
    const uniqueSubjectIds = Array.from(new Set(items.map((i) => i.subjectId)));
    const subjects =
      uniqueSubjectIds.length > 0
        ? await this.subjectsRepo
            .createQueryBuilder('s')
            .where('s.id IN (:...ids)', { ids: uniqueSubjectIds })
            .getMany()
        : [];
    const subjectMap = new Map(subjects.map((s) => [s.id, s]));

    const rejected: BulkImportSummary['rejected'] = [];
    const passed: CreateSyllabusTopicDto[] = [];
    items.forEach((item, index) => {
      const subject = subjectMap.get(item.subjectId);
      if (!subject) {
        rejected.push({
          index,
          reason: `subject ${item.subjectId} does not exist`,
          item,
        });
        return;
      }
      if (subject.examType !== item.examType) {
        rejected.push({
          index,
          reason: `subject.examType (${subject.examType}) does not match item.examType (${item.examType})`,
          item,
        });
        return;
      }
      if (!item.title.trim()) {
        rejected.push({ index, reason: 'title is empty after trim', item });
        return;
      }
      passed.push(item);
    });

    if (passed.length === 0) {
      return {
        submitted: items.length,
        inserted: 0,
        updated: 0,
        rejected,
      };
    }

    // UPSERT pass. `on conflict` on the partial unique index → refresh
    // description + sort_order + re-activate if the row was soft-
    // deleted. `xmax = 0` on a returned row means "just inserted";
    // Postgres exposes this via `(xmax = 0) as inserted`.
    let inserted = 0;
    let updated = 0;
    await this.dataSource.transaction(async (em) => {
      for (const item of passed) {
        // `uq_syllabus_topics_active` is a partial unique INDEX (not
        // a table constraint), so `ON CONFLICT ON CONSTRAINT ...`
        // wouldn't match. Postgres's index-inference form requires
        // us to repeat the columns AND the `WHERE` predicate here so
        // the planner picks the same partial index.
        const rows: Array<{ inserted: boolean }> = await em.query(
          `insert into "syllabus_topics"
             ("subject_id", "exam_type", "form_level", "title", "description", "sort_order", "is_active", "created_at")
           values ($1, $2::exam_type_enum, $3, $4, $5, $6, true, now())
           on conflict ("subject_id", "exam_type", "form_level", "title")
             where "is_active" = true
             do update
               set "description" = excluded."description",
                   "sort_order" = excluded."sort_order",
                   "is_active" = true
           returning (xmax = 0) as inserted;`,
          [
            item.subjectId,
            item.examType,
            item.formLevel,
            item.title.trim(),
            item.description?.trim() || null,
            item.sortOrder ?? 0,
          ],
        );
        if (rows[0]?.inserted) inserted += 1;
        else updated += 1;
      }
    });

    if (rejected.length > 0) {
      this.logger.warn(
        `[syllabus-bulk] ${passed.length}/${items.length} landed; ${rejected.length} rejected`,
      );
    }
    return {
      submitted: items.length,
      inserted,
      updated,
      rejected,
    };
  }

  // ------------------------- helpers -------------------------

  private async assertSubjectExists(
    subjectId: string,
    examType: ExamType,
  ): Promise<void> {
    const subject = await this.subjectsRepo.findOne({
      where: { id: subjectId },
    });
    if (!subject) {
      throw new NotFoundException('Subject not found');
    }
    if (subject.examType !== examType) {
      throw new BadRequestException(
        `subject.examType (${subject.examType}) does not match provided examType (${examType})`,
      );
    }
  }
}
