import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WeaknessNarrativeService } from './weakness-narrative.service';
import { WeaknessNarrative } from './entities/weakness-narrative.entity';
import { StudentSignalService } from './student-signal.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AiService } from '../ai/ai.service';
import { RejectLogService } from '../ai/reject-log.service';

/**
 * WeaknessNarrativeService (v2) coverage. The load-bearing invariants:
 *
 *   - Same-day cache hit MUST short-circuit before the entitlement
 *     charge, otherwise a Plus user is billed per HTTP call rather than
 *     per unique (day, scope) narrative.
 *   - Cache miss MUST call assertAndConsume BEFORE the Bedrock call,
 *     otherwise a rate-limited user still pays for a Bedrock request
 *     the guard would have rejected.
 *   - A malformed envelope MUST NOT persist — a same-day replay would
 *     then return the bad cache and lock the user out; the reject is
 *     logged for drift telemetry.
 *   - Recommendations citing invented reading are rejected.
 */
describe('WeaknessNarrativeService', () => {
  let service: WeaknessNarrativeService;
  let narrativesRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let signals: {
    forUser: jest.Mock;
    render: jest.Mock;
    fingerprint: jest.Mock;
  };
  let entitlements: { assertAndConsume: jest.Mock };
  let ai: { callBedrock: jest.Mock };
  let rejectLog: { record: jest.Mock };
  let config: { get: jest.Mock };

  const SIGNAL = {
    weakTopics: [
      {
        syllabusTopicId: 'st-1',
        title: 'Vectors',
        subjectId: 's1',
        subjectName: 'Physics',
        formLevel: 2,
        answered: 10,
        correct: 3,
        accuracy: 0.3,
      },
      {
        syllabusTopicId: 'st-2',
        title: 'Binomial Expansion',
        subjectId: 's2',
        subjectName: 'Add Maths',
        formLevel: 2,
        answered: 8,
        correct: 2,
        accuracy: 0.25,
      },
    ],
    weakPastPaperTopics: [],
    strongTopics: [],
    strongPastPaperTopics: [],
    trend: [],
    recentMistakes: [],
    remediation: [
      {
        syllabusTopicId: 'st-1',
        chunks: [
          {
            id: 'chunk-1',
            chunkType: 'key_ideas',
            sectionTitle: 'Vectors — Key Ideas',
            sourcePage: 41,
          },
        ],
      },
    ],
    meta: { streakDays: 3, mockExamsTaken: 1 },
    hasSignal: true,
  };

  const GOOD_ENVELOPE = JSON.stringify({
    narrative:
      'You are making steady progress, but Vectors keeps slowing you down and Binomial Expansion trips you on the expansion step. Your accuracy climbs when you slow down on the setup. Start with the Vectors reading below, then retry a short set.',
    recommendations: [
      {
        syllabusTopicId: 'st-1',
        action: 'read',
        chunkId: 'chunk-1',
        label: 'Vectors — Key Ideas (p. 41)',
      },
      { syllabusTopicId: 'st-2', action: 'practice', count: 5 },
    ],
  });

  beforeEach(async () => {
    narrativesRepo = {
      findOne: jest.fn(),
      create: jest.fn((r: unknown) => r),
      save: jest.fn(async (r: unknown) => r),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    signals = {
      forUser: jest.fn().mockResolvedValue(SIGNAL),
      render: jest.fn().mockReturnValue('<data type="student_signal">…</data>'),
      fingerprint: jest.fn().mockReturnValue('abc123'),
    };
    entitlements = { assertAndConsume: jest.fn().mockResolvedValue({}) };
    ai = {
      callBedrock: jest.fn().mockResolvedValue({ content: GOOD_ENVELOPE }),
    };
    rejectLog = { record: jest.fn().mockResolvedValue(undefined) };
    config = {
      get: jest
        .fn()
        .mockReturnValue('anthropic.claude-haiku-4-5-20251001-v1:0'),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WeaknessNarrativeService,
        {
          provide: getRepositoryToken(WeaknessNarrative),
          useValue: narrativesRepo,
        },
        { provide: StudentSignalService, useValue: signals },
        { provide: EntitlementsService, useValue: entitlements },
        { provide: AiService, useValue: ai },
        { provide: RejectLogService, useValue: rejectLog },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(WeaknessNarrativeService);
  });

  it('returns the cached narrative without charging entitlement or hitting Bedrock', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce({
      narrative: 'yesterday-cached',
      recommendations: [{ syllabusTopicId: 'st-1', action: 'practice' }],
      generatedAt: new Date('2026-01-01T00:00:00Z'),
      model: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    });
    const out = await service.forUser('user-1', {});
    expect(out.cached).toBe(true);
    expect(out.narrative).toBe('yesterday-cached');
    expect(out.recommendations).toHaveLength(1);
    expect(entitlements.assertAndConsume).not.toHaveBeenCalled();
    expect(ai.callBedrock).not.toHaveBeenCalled();
  });

  it('charges the entitlement BEFORE calling Bedrock on cache miss', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce(null);
    await service.forUser('user-1', {});
    expect(entitlements.assertAndConsume).toHaveBeenCalledWith(
      'user-1',
      'ai_weakness_narratives',
    );
    const consumeOrder =
      entitlements.assertAndConsume.mock.invocationCallOrder[0];
    const bedrockOrder = ai.callBedrock.mock.invocationCallOrder[0];
    expect(consumeOrder).toBeLessThan(bedrockOrder);
  });

  it('persists narrative + validated recommendations on success', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce(null);
    const out = await service.forUser('user-1', {});
    expect(out.mode).toBe('personalised');
    expect(out.recommendations).toHaveLength(2);
    expect(out.recommendations[0]).toMatchObject({
      action: 'read',
      chunkId: 'chunk-1',
    });
    const saved = narrativesRepo.create.mock.calls[0][0] as {
      mode: string;
      recommendations: unknown[];
    };
    expect(saved.mode).toBe('personalised');
    expect(saved.recommendations).toHaveLength(2);
  });

  it('rejects + logs a malformed envelope and does not persist', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce(null);
    ai.callBedrock.mockResolvedValueOnce({ content: 'not json at all' });
    await expect(service.forUser('user-1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(narrativesRepo.save).not.toHaveBeenCalled();
    expect(rejectLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'weakness_narrative',
        reason: 'narrative_schema_invalid',
      }),
    );
  });

  it('rejects an envelope whose read recommendation cites invented reading', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce(null);
    ai.callBedrock.mockResolvedValueOnce({
      content: JSON.stringify({
        narrative: JSON.parse(GOOD_ENVELOPE).narrative,
        recommendations: [
          {
            syllabusTopicId: 'st-1',
            action: 'read',
            chunkId: 'made-up-chunk',
            label: 'Invented Chapter 9',
          },
        ],
      }),
    });
    await expect(service.forUser('user-1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(rejectLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'recommendation_invented_reading' }),
    );
  });

  it('returns canned bootstrap prose without hitting Bedrock or the entitlement when the user has zero signal', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce(null);
    signals.forUser.mockResolvedValueOnce({ ...SIGNAL, hasSignal: false });
    const out = await service.forUser('user-1', {});
    expect(out.mode).toBe('bootstrap');
    expect(out.narrative).toMatch(/Welcome/);
    expect(ai.callBedrock).not.toHaveBeenCalled();
    expect(entitlements.assertAndConsume).not.toHaveBeenCalled();
    const saved = narrativesRepo.create.mock.calls[0][0] as {
      mode: string;
      model: string;
    };
    expect(saved.mode).toBe('bootstrap');
    expect(saved.model).toBe('canned');
  });

  it('propagates mode from the cached row on a cache hit', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce({
      narrative: 'bootstrap prose',
      recommendations: null,
      generatedAt: new Date('2026-01-01T00:00:00Z'),
      mode: 'bootstrap',
      model: 'canned',
    });
    const out = await service.forUser('user-1', {});
    expect(out.cached).toBe(true);
    expect(out.mode).toBe('bootstrap');
    expect(out.recommendations).toEqual([]);
  });

  it('invalidateForToday deletes ALL of today rows (both modes — v2)', async () => {
    await service.invalidateForToday('user-1');
    expect(narrativesRepo.delete).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
    );
    const arg = narrativesRepo.delete.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(arg.mode).toBeUndefined();
  });

  it('scopes the cache PK to subjectId when passed', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce(null);
    await service.forUser('user-1', { subjectId: 'subj-1' });
    expect(narrativesRepo.findOne).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: 'user-1',
        subjectScope: 'subj-1',
      }),
    });
    const saved = narrativesRepo.create.mock.calls[0][0] as {
      subjectScope: string;
    };
    expect(saved.subjectScope).toBe('subj-1');
  });

  it('scopes the cache to "all" when subjectId is not provided', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce(null);
    await service.forUser('user-1', {});
    const saved = narrativesRepo.create.mock.calls[0][0] as {
      subjectScope: string;
    };
    expect(saved.subjectScope).toBe('all');
  });
});
