import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SyllabusIngestionService } from './syllabus-ingestion.service';
import { SyllabusStrand } from './entities/syllabus-strand.entity';
import { SyllabusSubStrand } from './entities/syllabus-sub-strand.entity';
import { SyllabusLearningOutcome } from './entities/syllabus-learning-outcome.entity';
import { SyllabusContentStandard } from './entities/syllabus-content-standard.entity';
import { SyllabusIndicator } from './entities/syllabus-indicator.entity';
import { SyllabusAssessmentItem } from './entities/syllabus-assessment-item.entity';
import { SyllabusPedagogyRef } from './entities/syllabus-pedagogy-ref.entity';
import { ExtractedSubStrand } from './extraction/syllabus-extraction.types';

// A fake repository whose findOne always misses (create path), create
// echoes the entity, and save stamps a deterministic id + returns it.
function fakeRepo(prefix: string) {
  let n = 0;
  return {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((x: Record<string, unknown>) => ({ ...x })),
    save: jest.fn((x: Record<string, unknown>) => {
      if (Array.isArray(x)) return Promise.resolve(x);
      n += 1;
      return Promise.resolve({ id: x.id ?? `${prefix}-${n}`, ...x });
    }),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  };
}

const EXTRACTED: ExtractedSubStrand = {
  formLevel: 1,
  strand: { code: '1', title: 'Modelling with Algebra' },
  subStrand: { code: '1.1', title: 'Number and Algebraic Patterns' },
  learningOutcomes: [{ code: '1.1.1.LO.1', statement: 'Solve binary ops.' }],
  contentStandards: [
    {
      code: '1.1.1.CS.1',
      statement: 'Demonstrate knowledge…',
      indicators: [
        {
          code: '1.1.1.LI.1',
          statement: 'Explain binary operations.',
          workedContent: 'Example: $a*b = a+b-2ab$.',
          assessmentItems: [
            { code: '1.1.1.AS.1', dokLevel: 1, question: 'Find 3*-2' },
            { code: '1.1.1.AS.1', dokLevel: 4, question: 'Shirts problem' },
          ],
        },
      ],
    },
  ],
  pedagogyRef: { competencies: 'Communication…', gesiSelValues: 'GESI…' },
};

describe('SyllabusIngestionService', () => {
  let service: SyllabusIngestionService;
  let indicators: ReturnType<typeof fakeRepo>;
  let assessmentItems: ReturnType<typeof fakeRepo>;

  beforeEach(async () => {
    indicators = fakeRepo('ind');
    assessmentItems = fakeRepo('ai');
    const moduleRef = await Test.createTestingModule({
      providers: [
        SyllabusIngestionService,
        {
          provide: getRepositoryToken(SyllabusStrand),
          useValue: fakeRepo('st'),
        },
        {
          provide: getRepositoryToken(SyllabusSubStrand),
          useValue: fakeRepo('ss'),
        },
        {
          provide: getRepositoryToken(SyllabusLearningOutcome),
          useValue: fakeRepo('lo'),
        },
        {
          provide: getRepositoryToken(SyllabusContentStandard),
          useValue: fakeRepo('cs'),
        },
        {
          provide: getRepositoryToken(SyllabusIndicator),
          useValue: indicators,
        },
        {
          provide: getRepositoryToken(SyllabusAssessmentItem),
          useValue: assessmentItems,
        },
        {
          provide: getRepositoryToken(SyllabusPedagogyRef),
          useValue: fakeRepo('ped'),
        },
      ],
    }).compile();
    service = moduleRef.get(SyllabusIngestionService);
  });

  it('ingests a sub-strand and returns per-level counts', async () => {
    const res = await service.ingestSubStrand('subject-1', EXTRACTED);
    expect(res.contentStandards).toBe(1);
    expect(res.indicators).toBe(1);
    expect(res.assessmentItems).toBe(2);
    expect(res.learningOutcomes).toBe(1);
  });

  it('creates the indicator as draft with denormalised subject + form', async () => {
    await service.ingestSubStrand('subject-1', EXTRACTED);
    expect(indicators.create).toHaveBeenCalledWith(
      expect.objectContaining({
        code: '1.1.1.LI.1',
        subjectId: 'subject-1',
        formLevel: 1,
        status: 'draft',
        workedContent: 'Example: $a*b = a+b-2ab$.',
      }),
    );
  });

  it('replaces assessment items (delete then save) so a re-run stays in sync', async () => {
    await service.ingestSubStrand('subject-1', EXTRACTED);
    expect(assessmentItems.delete).toHaveBeenCalled();
    expect(assessmentItems.save).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ dokLevel: 1 }),
        expect.objectContaining({ dokLevel: 4 }),
      ]),
    );
  });
});

describe('SyllabusIngestionService.ingestBatch', () => {
  it('validates each sub-strand: ingests the valid, reports the malformed', async () => {
    const indicators = fakeRepo('ind');
    const moduleRef = await Test.createTestingModule({
      providers: [
        SyllabusIngestionService,
        { provide: getRepositoryToken(SyllabusStrand), useValue: fakeRepo('st') },
        { provide: getRepositoryToken(SyllabusSubStrand), useValue: fakeRepo('ss') },
        { provide: getRepositoryToken(SyllabusLearningOutcome), useValue: fakeRepo('lo') },
        { provide: getRepositoryToken(SyllabusContentStandard), useValue: fakeRepo('cs') },
        { provide: getRepositoryToken(SyllabusIndicator), useValue: indicators },
        { provide: getRepositoryToken(SyllabusAssessmentItem), useValue: fakeRepo('ai') },
        { provide: getRepositoryToken(SyllabusPedagogyRef), useValue: fakeRepo('ped') },
      ],
    }).compile();
    const service: SyllabusIngestionService = moduleRef.get(SyllabusIngestionService);

    const valid = {
      formLevel: 1,
      strand: { code: '1', title: 'S' },
      subStrand: { code: '1.1', title: 'SS' },
      learningOutcomes: [],
      contentStandards: [
        {
          code: '1.1.1.CS.1',
          statement: 'CS',
          indicators: [
            {
              code: '1.1.1.LI.1',
              statement: 'LI',
              targetDokLevels: [2, 3],
              pedagogyExemplars: [{ heading: 'Digital Learning', items: ['a'] }],
            },
          ],
        },
      ],
    };
    const malformed = { strand: { code: '1' } }; // missing subStrand/CS

    const res = await service.ingestBatch('subject-1', [valid, malformed]);
    expect(res.ingested).toBe(1);
    expect(res.rejected).toBe(1);
    expect(res.errors[0].index).toBe(1);
    expect(indicators.create).toHaveBeenCalledWith(
      expect.objectContaining({
        code: '1.1.1.LI.1',
        targetDokLevels: [2, 3],
        pedagogyExemplars: [{ heading: 'Digital Learning', items: ['a'] }],
      }),
    );
  });
});
