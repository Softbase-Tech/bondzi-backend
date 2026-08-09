import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RejectLogService } from './reject-log.service';
import { AiGenerationRejectLog } from './entities/ai-generation-reject-log.entity';
import { AiGenerationRejectAgg } from './entities/ai-generation-reject-agg.entity';

/**
 * RejectLogService specs. Cover the two load-bearing paths:
 *
 *   record()
 *     - runs raw INSERT + agg UPSERT-increment INSIDE the same
 *       transaction (so a crash can't drift the aggregate)
 *     - agg SQL uses ON CONFLICT ... DO UPDATE SET count = count + 1
 *       (atomic increment, not overwrite)
 *     - raw_output truncated at ~16 KiB when the model dumps a
 *       massive blob — no runaway rows
 *
 *   pruneRawOlderThanDays()
 *     - delete WHERE created_at < now() - N days
 *     - returns the affected row count for logging
 *
 * The transaction is exercised via a fake DataSource whose
 * `transaction(fn)` calls fn with a fake EntityManager exposing a
 * `getRepository(...)` shim and a `query(...)` shim. The inserts
 * and the increment UPSERT both land against those, so the spec
 * can assert on the call shapes.
 */
describe('RejectLogService', () => {
  let service: RejectLogService;
  let rawRepo: {
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
  };
  let aggRepo: { find: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  // In-transaction spies. Populated when dataSource.transaction fires,
  // so tests can assert what happened INSIDE the tx.
  let txInsertSpy: jest.Mock;
  let txQuerySpy: jest.Mock;

  beforeEach(async () => {
    txInsertSpy = jest.fn().mockResolvedValue(undefined);
    txQuerySpy = jest.fn().mockResolvedValue([]);
    dataSource = {
      transaction: jest.fn(async (fn: (em: unknown) => Promise<unknown>) => {
        const em = {
          getRepository: () => ({ insert: txInsertSpy }),
          query: txQuerySpy,
        };
        return fn(em);
      }),
    };

    rawRepo = {
      createQueryBuilder: jest.fn(),
      find: jest.fn(),
    };
    aggRepo = { find: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RejectLogService,
        {
          provide: getRepositoryToken(AiGenerationRejectLog),
          useValue: rawRepo,
        },
        {
          provide: getRepositoryToken(AiGenerationRejectAgg),
          useValue: aggRepo,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(RejectLogService);
  });

  describe('record', () => {
    it('runs both writes inside a single transaction', async () => {
      await service.record({
        action: 'question_generation',
        provider: 'ollama',
        model: 'ollama:llama3.1:8b',
        reason: 'duplicate_option_text',
        detail: 'item 3 dupe',
        rawOutput: 'raw blob',
      });
      // Exactly ONE transaction, both writes inside it.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(txInsertSpy).toHaveBeenCalledTimes(1);
      expect(txQuerySpy).toHaveBeenCalledTimes(1);
    });

    it('inserts the raw row with the input fields and defaults nulls', async () => {
      await service.record({
        action: 'explanation',
        provider: 'bedrock',
        model: 'anthropic.claude-haiku',
        reason: 'missing_example_section',
        // detail + rawOutput + jobId intentionally omitted
      });
      expect(txInsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'explanation',
          provider: 'bedrock',
          model: 'anthropic.claude-haiku',
          reason: 'missing_example_section',
          detail: null,
          rawOutput: null,
          jobId: null,
        }),
      );
    });

    it('increments the aggregate via ON CONFLICT DO UPDATE (atomic, not overwrite)', async () => {
      await service.record({
        action: 'question_generation',
        provider: 'ollama',
        model: 'ollama:llama3.1:8b',
        reason: 'multiple_correct',
      });
      expect(txQuerySpy).toHaveBeenCalledTimes(1);
      const [sql, params] = txQuerySpy.mock.calls[0] as [string, unknown[]];
      const normalised = sql.toLowerCase();
      // Pin the atomicity-critical clauses so a refactor can't
      // silently swap this for `.upsert()` which would overwrite
      // rather than increment.
      expect(normalised).toContain('insert into');
      expect(normalised).toContain('ai_generation_reject_agg');
      expect(normalised).toContain('on conflict');
      // Increment must reference the EXISTING count and add 1, not
      // overwrite. `[\s\S]` handles the newlines in the raw SQL.
      expect(normalised).toMatch(/count[\s\S]*count[\s\S]*\+\s*1/);
      // week_start param is Monday of the current week — ISO YYYY-MM-DD.
      expect(params[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Reason / provider / model passed through as-is.
      expect(params[1]).toBe('multiple_correct');
      expect(params[2]).toBe('ollama');
      expect(params[3]).toBe('ollama:llama3.1:8b');
    });

    it('truncates raw_output to 16 KiB + suffix so a runaway model output cannot blow up the row', async () => {
      const huge = 'A'.repeat(20 * 1024);
      await service.record({
        action: 'question_generation',
        provider: 'ollama',
        model: 'ollama:llama3.1:8b',
        reason: 'schema_invalid',
        rawOutput: huge,
      });
      const inserted = txInsertSpy.mock.calls[0][0] as {
        rawOutput: string;
      };
      // 16 KiB + our truncation suffix marker.
      expect(inserted.rawOutput.length).toBeLessThan(20 * 1024);
      expect(inserted.rawOutput.length).toBeGreaterThan(16 * 1024 - 1);
      expect(inserted.rawOutput.endsWith('[truncated]')).toBe(true);
    });
  });

  describe('pruneRawOlderThanDays', () => {
    it('runs a DELETE with a cutoff of (now - days) and returns the affected row count', async () => {
      const executeSpy = jest.fn().mockResolvedValue({ affected: 42 });
      const where = jest.fn().mockReturnValue({ execute: executeSpy });
      const from = jest.fn().mockReturnValue({ where });
      const del = jest.fn().mockReturnValue({ from });
      rawRepo.createQueryBuilder.mockReturnValueOnce({ delete: del });

      const affected = await service.pruneRawOlderThanDays(30);
      expect(affected).toBe(42);

      // Verify the cutoff parameter is ~30 days in the past —
      // tolerance for the tiny wall-clock drift between the
      // service's `new Date()` and the spec's own `new Date()`.
      const cutoffArg = where.mock.calls[0][1] as { cutoff: Date };
      const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
      expect(Math.abs(cutoffArg.cutoff.getTime() - expected)).toBeLessThan(
        5_000,
      );
    });

    it('returns 0 (not undefined) when no rows match — safe for the callers log line', async () => {
      const executeSpy = jest.fn().mockResolvedValue({ affected: undefined });
      const where = jest.fn().mockReturnValue({ execute: executeSpy });
      const from = jest.fn().mockReturnValue({ where });
      const del = jest.fn().mockReturnValue({ from });
      rawRepo.createQueryBuilder.mockReturnValueOnce({ delete: del });

      const affected = await service.pruneRawOlderThanDays();
      expect(affected).toBe(0);
    });
  });

  describe('listRaw', () => {
    it('caps limit at 200, defaults to 50, and composes reason/provider/model filters', async () => {
      const getManyAndCount = jest.fn().mockResolvedValueOnce([[], 0]);
      const andWhere = jest.fn().mockReturnThis();
      const skip = jest.fn().mockReturnThis();
      const take = jest.fn().mockReturnThis();
      const orderBy = jest.fn().mockReturnThis();
      const qb = {
        orderBy,
        skip,
        take,
        andWhere,
        getManyAndCount,
      };
      rawRepo.createQueryBuilder.mockReturnValueOnce(qb);
      await service.listRaw({
        limit: 999,
        offset: 100,
        reason: 'multiple_correct',
        provider: 'ollama',
        model: 'ollama:llama3.1:8b',
      });
      expect(take).toHaveBeenCalledWith(200);
      expect(skip).toHaveBeenCalledWith(100);
      expect(andWhere).toHaveBeenCalledTimes(3);
    });
  });
});
