import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WeaknessNarrativeService } from './weakness-narrative.service';
import { WeaknessNarrative } from './entities/weakness-narrative.entity';
import { WeaknessService } from './weakness.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { AiService } from '../ai/ai.service';

/**
 * WeaknessNarrativeService coverage. The load-bearing invariants:
 *
 *   - Same-day cache hit MUST short-circuit before the entitlement
 *     charge, otherwise a Plus user is billed per HTTP call rather than
 *     per unique (day, scope) narrative.
 *   - Cache miss MUST call assertAndConsume BEFORE the Bedrock call,
 *     otherwise a rate-limited user still pays for a Bedrock request
 *     the guard would have rejected.
 *   - Empty AI response MUST NOT persist an empty row — a same-day
 *     replay would then return the empty cache and lock the user out.
 */
describe('WeaknessNarrativeService', () => {
  let service: WeaknessNarrativeService;
  let narrativesRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let weakness: { forUser: jest.Mock };
  let entitlements: { assertAndConsume: jest.Mock };
  let ai: { callBedrock: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    narrativesRepo = {
      findOne: jest.fn(),
      create: jest.fn((r: unknown) => r),
      save: jest.fn(async (r: unknown) => r),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    weakness = {
      forUser: jest.fn().mockResolvedValue({
        pastPaperWeakTopics: [
          {
            topicId: 't-1',
            title: 'Vectors',
            answered: 10,
            correct: 3,
            accuracy: 0.3,
          },
        ],
        syllabusWeakTopics: [],
      }),
    };
    entitlements = { assertAndConsume: jest.fn().mockResolvedValue({}) };
    ai = {
      callBedrock: jest.fn().mockResolvedValue({
        content: 'You keep tripping on Vectors. Try 10 mixed questions today.',
      }),
    };
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
        { provide: WeaknessService, useValue: weakness },
        { provide: EntitlementsService, useValue: entitlements },
        { provide: AiService, useValue: ai },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(WeaknessNarrativeService);
  });

  it('returns the cached narrative without charging entitlement or hitting Bedrock', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce({
      narrative: 'yesterday-cached',
      generatedAt: new Date('2026-01-01T00:00:00Z'),
      model: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    });
    const out = await service.forUser('user-1', {});
    expect(out.cached).toBe(true);
    expect(out.narrative).toBe('yesterday-cached');
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

  it('does not persist an empty Bedrock response', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce(null);
    ai.callBedrock.mockResolvedValueOnce({ content: '   ' });
    await expect(service.forUser('user-1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(narrativesRepo.save).not.toHaveBeenCalled();
  });

  it('returns canned bootstrap prose without hitting Bedrock or the entitlement when the user has zero weakness signal', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce(null);
    weakness.forUser.mockResolvedValueOnce({
      pastPaperWeakTopics: [],
      syllabusWeakTopics: [],
    });
    const out = await service.forUser('user-1', {});
    expect(out.mode).toBe('bootstrap');
    expect(out.narrative).toMatch(/Welcome/);
    expect(ai.callBedrock).not.toHaveBeenCalled();
    expect(entitlements.assertAndConsume).not.toHaveBeenCalled();
    // Row is persisted with mode=bootstrap so same-day repeats short-circuit
    // via the cache-hit branch without a second signal check.
    const saved = narrativesRepo.create.mock.calls[0][0] as {
      mode: string;
      model: string;
    };
    expect(saved.mode).toBe('bootstrap');
    expect(saved.model).toBe('canned');
  });

  it('flags personalised rows with mode=personalised', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce(null);
    const out = await service.forUser('user-1', {});
    expect(out.mode).toBe('personalised');
    const saved = narrativesRepo.create.mock.calls[0][0] as { mode: string };
    expect(saved.mode).toBe('personalised');
  });

  it('propagates mode from the cached row on a cache hit', async () => {
    narrativesRepo.findOne.mockResolvedValueOnce({
      narrative: 'bootstrap prose',
      generatedAt: new Date('2026-01-01T00:00:00Z'),
      mode: 'bootstrap',
      model: 'canned',
    });
    const out = await service.forUser('user-1', {});
    expect(out.cached).toBe(true);
    expect(out.mode).toBe('bootstrap');
  });

  it('invalidateBootstrapForToday deletes only bootstrap rows for today', async () => {
    await service.invalidateBootstrapForToday('user-1');
    expect(narrativesRepo.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        mode: 'bootstrap',
      }),
    );
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
    // Persisted row also carries the same scope.
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
