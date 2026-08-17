import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DEFAULT_CURRICULUM_VERSION,
  SyllabusStrand,
} from './entities/syllabus-strand.entity';
import { SyllabusSubStrand } from './entities/syllabus-sub-strand.entity';
import { SyllabusLearningOutcome } from './entities/syllabus-learning-outcome.entity';
import { SyllabusContentStandard } from './entities/syllabus-content-standard.entity';
import {
  SyllabusIndicator,
  SyllabusSourceRef,
} from './entities/syllabus-indicator.entity';
import { SyllabusAssessmentItem } from './entities/syllabus-assessment-item.entity';
import { SyllabusPedagogyRef } from './entities/syllabus-pedagogy-ref.entity';
import { ExtractedSubStrand } from './extraction/syllabus-extraction.types';

export interface IngestResult {
  strandId: string;
  subStrandId: string;
  contentStandards: number;
  indicators: number;
  assessmentItems: number;
  learningOutcomes: number;
}

/**
 * Loads a validated `ExtractedSubStrand` into the hierarchy tables.
 *
 * Idempotent by design: every level is upserted by its natural key
 * (codes, scoped by subject + curriculum version), so a re-run — e.g.
 * after a mid-batch failure, or a re-extraction — converges rather than
 * duplicating. Because writes are idempotent, we deliberately don't wrap
 * this in a single transaction: a partial run is simply completed by the
 * next run.
 *
 * New/changed indicators always land as `status='draft'` — re-extracting
 * an indicator resets it for admin re-review rather than silently
 * mutating an approved row. Boilerplate is deduped into a single
 * per-subject `pedagogy_refs` row and never embedded.
 */
@Injectable()
export class SyllabusIngestionService {
  private readonly logger = new Logger(SyllabusIngestionService.name);

  constructor(
    @InjectRepository(SyllabusStrand)
    private readonly strands: Repository<SyllabusStrand>,
    @InjectRepository(SyllabusSubStrand)
    private readonly subStrands: Repository<SyllabusSubStrand>,
    @InjectRepository(SyllabusLearningOutcome)
    private readonly outcomes: Repository<SyllabusLearningOutcome>,
    @InjectRepository(SyllabusContentStandard)
    private readonly contentStandards: Repository<SyllabusContentStandard>,
    @InjectRepository(SyllabusIndicator)
    private readonly indicators: Repository<SyllabusIndicator>,
    @InjectRepository(SyllabusAssessmentItem)
    private readonly assessmentItems: Repository<SyllabusAssessmentItem>,
    @InjectRepository(SyllabusPedagogyRef)
    private readonly pedagogyRefs: Repository<SyllabusPedagogyRef>,
  ) {}

  async ingestSubStrand(
    subjectId: string,
    extracted: ExtractedSubStrand,
    opts: { curriculumVersion?: string; sourceRef?: SyllabusSourceRef } = {},
  ): Promise<IngestResult> {
    const curriculumVersion =
      opts.curriculumVersion ?? DEFAULT_CURRICULUM_VERSION;
    const formLevel = extracted.formLevel;

    const strand = await this.upsertStrand(
      subjectId,
      formLevel,
      curriculumVersion,
      extracted.strand,
    );
    const subStrand = await this.upsertSubStrand(
      strand.id,
      extracted.subStrand,
    );

    let loCount = 0;
    for (let i = 0; i < extracted.learningOutcomes.length; i += 1) {
      await this.upsertLearningOutcome(
        subStrand.id,
        extracted.learningOutcomes[i],
        i,
      );
      loCount += 1;
    }

    let csCount = 0;
    let indCount = 0;
    let aiCount = 0;
    for (let ci = 0; ci < extracted.contentStandards.length; ci += 1) {
      const csIn = extracted.contentStandards[ci];
      const cs = await this.upsertContentStandard(subStrand.id, csIn, ci);
      csCount += 1;

      for (let ii = 0; ii < csIn.indicators.length; ii += 1) {
        const indIn = csIn.indicators[ii];
        const indicator = await this.upsertIndicator({
          contentStandardId: cs.id,
          subjectId,
          formLevel,
          curriculumVersion,
          sortOrder: ii,
          sourceRef: opts.sourceRef ?? null,
          indicator: indIn,
        });
        indCount += 1;

        // Replace assessment items wholesale — they have no stable natural
        // key of their own (the `AS` code repeats across DoK levels), so a
        // clean re-sync is simpler and correct.
        await this.assessmentItems.delete({ indicatorId: indicator.id });
        const items = (indIn.assessmentItems ?? []).map((ai, idx) =>
          this.assessmentItems.create({
            indicatorId: indicator.id,
            code: ai.code,
            dokLevel: ai.dokLevel,
            question: ai.question,
            solution: ai.solution ?? null,
            sortOrder: idx,
          }),
        );
        if (items.length > 0) await this.assessmentItems.save(items);
        aiCount += items.length;
      }
    }

    if (extracted.pedagogyRef) {
      await this.upsertPedagogyRef(subjectId, curriculumVersion, extracted);
    }

    this.logger.log(
      `[syllabus] ingested subject=${subjectId} ${extracted.strand.code}/${extracted.subStrand.code} (form ${formLevel}): ${csCount} CS, ${indCount} LI, ${aiCount} AS`,
    );

    return {
      strandId: strand.id,
      subStrandId: subStrand.id,
      contentStandards: csCount,
      indicators: indCount,
      assessmentItems: aiCount,
      learningOutcomes: loCount,
    };
  }

  private async upsertStrand(
    subjectId: string,
    formLevel: number,
    curriculumVersion: string,
    input: { code: string; title: string },
  ): Promise<SyllabusStrand> {
    const existing = await this.strands.findOne({
      where: { subjectId, formLevel, curriculumVersion, code: input.code },
    });
    if (existing) {
      existing.title = input.title;
      return this.strands.save(existing);
    }
    return this.strands.save(
      this.strands.create({
        subjectId,
        formLevel,
        curriculumVersion,
        code: input.code,
        title: input.title,
      }),
    );
  }

  private async upsertSubStrand(
    strandId: string,
    input: { code: string; title: string },
  ): Promise<SyllabusSubStrand> {
    const existing = await this.subStrands.findOne({
      where: { strandId, code: input.code },
    });
    if (existing) {
      existing.title = input.title;
      return this.subStrands.save(existing);
    }
    return this.subStrands.save(
      this.subStrands.create({
        strandId,
        code: input.code,
        title: input.title,
      }),
    );
  }

  private async upsertLearningOutcome(
    subStrandId: string,
    input: { code: string; statement: string },
    sortOrder: number,
  ): Promise<void> {
    const existing = await this.outcomes.findOne({
      where: { subStrandId, code: input.code },
    });
    if (existing) {
      existing.statement = input.statement;
      existing.sortOrder = sortOrder;
      await this.outcomes.save(existing);
      return;
    }
    await this.outcomes.save(
      this.outcomes.create({
        subStrandId,
        code: input.code,
        statement: input.statement,
        sortOrder,
      }),
    );
  }

  private async upsertContentStandard(
    subStrandId: string,
    input: { code: string; statement: string },
    sortOrder: number,
  ): Promise<SyllabusContentStandard> {
    const existing = await this.contentStandards.findOne({
      where: { subStrandId, code: input.code },
    });
    if (existing) {
      existing.statement = input.statement;
      existing.sortOrder = sortOrder;
      return this.contentStandards.save(existing);
    }
    return this.contentStandards.save(
      this.contentStandards.create({
        subStrandId,
        code: input.code,
        statement: input.statement,
        sortOrder,
      }),
    );
  }

  private async upsertIndicator(args: {
    contentStandardId: string;
    subjectId: string;
    formLevel: number;
    curriculumVersion: string;
    sortOrder: number;
    sourceRef: SyllabusSourceRef | null;
    indicator: ExtractedSubStrand['contentStandards'][number]['indicators'][number];
  }): Promise<SyllabusIndicator> {
    const { indicator } = args;
    // Scoped to the content standard: LI codes reset per CS, so the same code
    // legitimately recurs under different content standards (see migration
    // 2190 + the entity's unique constraint).
    const existing = await this.indicators.findOne({
      where: {
        contentStandardId: args.contentStandardId,
        code: indicator.code,
      },
    });
    if (existing) {
      existing.contentStandardId = args.contentStandardId;
      existing.formLevel = args.formLevel;
      existing.statement = indicator.statement;
      existing.workedContent = indicator.workedContent ?? null;
      existing.sortOrder = args.sortOrder;
      if (args.sourceRef) existing.sourceRef = args.sourceRef;
      // Re-extraction → back to draft for admin re-review.
      existing.status = 'draft';
      return this.indicators.save(existing);
    }
    return this.indicators.save(
      this.indicators.create({
        contentStandardId: args.contentStandardId,
        subjectId: args.subjectId,
        formLevel: args.formLevel,
        curriculumVersion: args.curriculumVersion,
        code: indicator.code,
        statement: indicator.statement,
        workedContent: indicator.workedContent ?? null,
        sourceRef: args.sourceRef,
        status: 'draft',
        sortOrder: args.sortOrder,
      }),
    );
  }

  private async upsertPedagogyRef(
    subjectId: string,
    curriculumVersion: string,
    extracted: ExtractedSubStrand,
  ): Promise<void> {
    const ref = extracted.pedagogyRef;
    if (!ref) return;
    const existing = await this.pedagogyRefs.findOne({
      where: { subjectId, scope: 'subject', curriculumVersion },
    });
    if (existing) {
      existing.competencies = ref.competencies ?? existing.competencies;
      existing.gesiSelValues = ref.gesiSelValues ?? existing.gesiSelValues;
      await this.pedagogyRefs.save(existing);
      return;
    }
    await this.pedagogyRefs.save(
      this.pedagogyRefs.create({
        subjectId,
        scope: 'subject',
        curriculumVersion,
        competencies: ref.competencies ?? null,
        gesiSelValues: ref.gesiSelValues ?? null,
      }),
    );
  }
}
