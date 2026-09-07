import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SyllabusTopicsService } from './syllabus-topics.service';
import { SyllabusTopic } from './entities/syllabus-topic.entity';
import { Subject } from './entities/subject.entity';
import { ExamType } from '../../common/types/enums';

/**
 * SyllabusTopicsService covers three surfaces:
 *
 *   list()       - the picker; filters compose cleanly, only active
 *                  rows are returned, sort_order wins over title
 *   create/update/softDelete - the admin authoring path; the
 *                  partial-unique-index violation must be surfaced as
 *                  a clean 400, not a raw pg error
 *   bulkImport() - idempotent upsert + preflight validation; the
 *                  operator sees "N inserted, M updated, K rejected"
 *                  in one pass instead of chasing errors one at a time
 */
describe('SyllabusTopicsService', () => {
  let service: SyllabusTopicsService;
  let repo: {
    createQueryBuilder: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let subjectsRepo: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let config: { get: jest.Mock };
  let txQuerySpy: jest.Mock;

  beforeEach(async () => {
    repo = {
      createQueryBuilder: jest.fn(),
      create: jest.fn((o: unknown) => o),
      save: jest.fn(async (r: unknown) => ({ id: 't-1', ...(r as object) })),
      findOne: jest.fn(),
    };
    subjectsRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    txQuerySpy = jest.fn();
    dataSource = {
      transaction: jest.fn(async (fn: (em: unknown) => Promise<unknown>) => {
        return fn({ query: txQuerySpy });
      }),
    };
    config = {
      get: jest.fn((key: string) => {
        if (key === 'ai.maxItemsPerBatch') return 200;
        return undefined;
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SyllabusTopicsService,
        { provide: getRepositoryToken(SyllabusTopic), useValue: repo },
        { provide: getRepositoryToken(Subject), useValue: subjectsRepo },
        { provide: DataSource, useValue: dataSource },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(SyllabusTopicsService);
  });

  function stubListQb(rows: SyllabusTopic[]): {
    andWhere: jest.Mock;
  } {
    const andWhere = jest.fn().mockReturnThis();
    const qb = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      andWhere,
      getMany: jest.fn().mockResolvedValue(rows),
    };
    repo.createQueryBuilder.mockReturnValueOnce(qb);
    return { andWhere };
  }

  describe('list', () => {
    it('applies only active rows and no filters when none are passed', async () => {
      const { andWhere } = stubListQb([]);
      await service.list({});
      expect(andWhere).not.toHaveBeenCalled();
    });

    it('composes examType + subjectId + formLevel when all three are set', async () => {
      const { andWhere } = stubListQb([]);
      await service.list({
        examType: ExamType.WASSCE,
        subjectId: 's-1',
        formLevel: 2,
      });
      expect(andWhere).toHaveBeenCalledTimes(3);
      expect(andWhere).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('exam_type'),
        { et: ExamType.WASSCE },
      );
      expect(andWhere).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('subject_id'),
        { sid: 's-1' },
      );
      expect(andWhere).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('form_level'),
        { fl: 2 },
      );
    });
  });

  describe('create', () => {
    it('validates the subject exists and its examType matches', async () => {
      subjectsRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.create({
          subjectId: 's-1',
          examType: ExamType.WASSCE,
          formLevel: 1,
          title: 'Vectors',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects examType mismatch between DTO and subject row', async () => {
      subjectsRepo.findOne.mockResolvedValueOnce({
        id: 's-1',
        examType: ExamType.BECE,
      } as never);
      await expect(
        service.create({
          subjectId: 's-1',
          examType: ExamType.WASSCE,
          formLevel: 1,
          title: 'Vectors',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('translates the partial-unique-index violation into a clean 400', async () => {
      subjectsRepo.findOne.mockResolvedValueOnce({
        id: 's-1',
        examType: ExamType.WASSCE,
      } as never);
      repo.save.mockRejectedValueOnce(
        new Error(
          'duplicate key value violates unique constraint "uq_syllabus_topics_active"',
        ),
      );
      await expect(
        service.create({
          subjectId: 's-1',
          examType: ExamType.WASSCE,
          formLevel: 1,
          title: 'Vectors',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update — custom titles', () => {
    it('marks the title custom when an admin renames it', async () => {
      const row = {
        id: 't-1',
        title: 'Demonstrate knowledge of X.',
        isTitleCustom: false,
      };
      repo.findOne.mockResolvedValueOnce(row as never);
      await service.update('t-1', { title: 'Nature of Accounting' } as never);
      expect(row.title).toBe('Nature of Accounting');
      expect(row.isTitleCustom).toBe(true);
    });

    it('does not mark custom when the title is unchanged', async () => {
      const row = {
        id: 't-1',
        title: 'Nature of Accounting',
        isTitleCustom: false,
        sortOrder: 0,
      };
      repo.findOne.mockResolvedValueOnce(row as never);
      await service.update('t-1', {
        title: 'Nature of Accounting',
        sortOrder: 3,
      } as never);
      expect(row.isTitleCustom).toBe(false);
      expect(row.sortOrder).toBe(3);
    });
  });

  describe('softDelete', () => {
    it('throws NotFound on unknown id', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(service.softDelete('ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('is a no-op when the row is already inactive', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 't-1',
        isActive: false,
      } as never);
      await service.softDelete('t-1');
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('flips isActive=false on an active row', async () => {
      const row = { id: 't-1', isActive: true };
      repo.findOne.mockResolvedValueOnce(row as never);
      await service.softDelete('t-1');
      expect(row.isActive).toBe(false);
      expect(repo.save).toHaveBeenCalledWith(row);
    });
  });

  describe('bulkImport', () => {
    function seedSubjects(subjects: Array<Partial<Subject>>): void {
      subjectsRepo.createQueryBuilder.mockReturnValueOnce({
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(subjects),
      });
    }

    it('early-returns when items is empty (no subject lookup, no tx)', async () => {
      const result = await service.bulkImport([]);
      expect(result).toEqual({
        submitted: 0,
        inserted: 0,
        updated: 0,
        rejected: [],
      });
      expect(subjectsRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects the whole batch when it exceeds ai.maxItemsPerBatch', async () => {
      const items = Array.from({ length: 201 }, (_, i) => ({
        subjectId: 's-1',
        examType: ExamType.WASSCE,
        formLevel: 1,
        title: `t${i}`,
      }));
      await expect(service.bulkImport(items)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('collects per-item rejects instead of aborting the batch', async () => {
      seedSubjects([
        { id: 's-good', examType: ExamType.WASSCE },
        // s-bad-type has examType=BECE but items claim WASSCE
        { id: 's-bad-type', examType: ExamType.BECE },
        // s-missing intentionally not seeded
      ]);
      txQuerySpy.mockResolvedValue([{ inserted: true }]);

      const result = await service.bulkImport([
        {
          subjectId: 's-good',
          examType: ExamType.WASSCE,
          formLevel: 1,
          title: 'Vectors',
        },
        {
          subjectId: 's-missing',
          examType: ExamType.WASSCE,
          formLevel: 1,
          title: 'Ghost',
        },
        {
          subjectId: 's-bad-type',
          examType: ExamType.WASSCE,
          formLevel: 1,
          title: 'Wrong exam',
        },
        {
          subjectId: 's-good',
          examType: ExamType.WASSCE,
          formLevel: 1,
          title: '   ',
        },
      ]);

      expect(result.submitted).toBe(4);
      expect(result.inserted).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.rejected).toHaveLength(3);
      expect(result.rejected.map((r) => r.reason)).toEqual([
        expect.stringContaining('does not exist'),
        expect.stringContaining('does not match'),
        expect.stringContaining('title is empty'),
      ]);
    });

    it('counts inserts vs updates via the RETURNING (xmax=0) hint', async () => {
      seedSubjects([{ id: 's-1', examType: ExamType.WASSCE }]);
      // Alternate insert / update so we can pin both counters.
      txQuerySpy
        .mockResolvedValueOnce([{ inserted: true }])
        .mockResolvedValueOnce([{ inserted: false }])
        .mockResolvedValueOnce([{ inserted: true }]);
      const result = await service.bulkImport([
        {
          subjectId: 's-1',
          examType: ExamType.WASSCE,
          formLevel: 1,
          title: 'A',
        },
        {
          subjectId: 's-1',
          examType: ExamType.WASSCE,
          formLevel: 1,
          title: 'B',
        },
        {
          subjectId: 's-1',
          examType: ExamType.WASSCE,
          formLevel: 1,
          title: 'C',
        },
      ]);
      expect(result.inserted).toBe(2);
      expect(result.updated).toBe(1);
      expect(result.rejected).toHaveLength(0);
      // Confirm the UPSERT SQL uses index inference (columns + WHERE),
      // not `ON CONSTRAINT` — Postgres would reject the latter on a
      // partial unique INDEX.
      const sql = (txQuerySpy.mock.calls[0][0] as string).toLowerCase();
      expect(sql).toContain('on conflict (');
      expect(sql).toContain('where "is_active" = true');
      expect(sql).toContain('do update');
      expect(sql).toContain('returning');
    });
  });
});
