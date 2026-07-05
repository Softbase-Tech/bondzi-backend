import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AiService } from './ai.service';
import { AI_GENERATION_CLIENT } from './clients/ai-generation.factory';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { PromptTemplate } from './entities/prompt-template.entity';
import { RedisService } from '../../common/redis/redis.service';
import { AiBudgetExceededException } from './ai.exceptions';
import { AiAction } from '../../common/types/enums';

/**
 * AiService specs. Coverage focus:
 *   - checkBudget enforces both the global daily cap and the per-user cap
 *     (the cost guard guarantees a runaway model can never blow the bill).
 *   - callBedrock delegates to the factory-picked AiGenerationClient,
 *     logs usage against the effectiveModel it reports, and rolls
 *     today's cost forward in Redis.
 *   - getActivePrompt throws when no template is active so callers can't
 *     silently use the wrong prompt.
 */

describe('AiService', () => {
  let service: AiService;
  let bedrock: { invoke: jest.Mock };
  let usage: { insert: jest.Mock };
  let prompts: { findOne: jest.Mock };
  let redis: { get: jest.Mock; incr: jest.Mock; incrByFloat: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    bedrock = { invoke: jest.fn() };
    usage = { insert: jest.fn() };
    prompts = { findOne: jest.fn() };
    redis = {
      get: jest.fn(),
      incr: jest.fn(),
      incrByFloat: jest.fn(),
    };
    config = {
      get: jest.fn((key: string) => {
        if (key === 'ai.dailyBudgetUsd') return 50;
        if (key === 'ai.perUserDailyLimit') return 50;
        return undefined;
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AiService,
        { provide: ConfigService, useValue: config },
        { provide: RedisService, useValue: redis },
        { provide: AI_GENERATION_CLIENT, useValue: bedrock },
        { provide: getRepositoryToken(AiUsageLog), useValue: usage },
        { provide: getRepositoryToken(PromptTemplate), useValue: prompts },
      ],
    }).compile();
    service = moduleRef.get(AiService);
  });

  // ---------------------------- checkBudget ----------------------------

  describe('checkBudget', () => {
    it('throws AiBudgetExceededException("global") when daily spend >= cap', async () => {
      redis.get.mockResolvedValueOnce('50.01');
      await expect(service.checkBudget('user-1')).rejects.toBeInstanceOf(
        AiBudgetExceededException,
      );
    });

    it('throws AiBudgetExceededException("user") when per-user daily calls exceed the limit', async () => {
      redis.get.mockResolvedValueOnce('0');
      redis.incr.mockResolvedValueOnce(51);
      await expect(service.checkBudget('user-1')).rejects.toBeInstanceOf(
        AiBudgetExceededException,
      );
    });

    it('passes when both caps are within bounds', async () => {
      redis.get.mockResolvedValueOnce('10');
      redis.incr.mockResolvedValueOnce(5);
      await expect(service.checkBudget('user-1')).resolves.toBeUndefined();
    });

    it('skips the per-user check for admin / job calls (no userId)', async () => {
      redis.get.mockResolvedValueOnce('10');
      await service.checkBudget();
      expect(redis.incr).not.toHaveBeenCalled();
    });
  });

  // --------------------------- callBedrock ---------------------------

  describe('callBedrock', () => {
    it('forwards the prompt + model to BedrockClient, logs usage and adds cost', async () => {
      bedrock.invoke.mockResolvedValueOnce({
        text: 'an explanation',
        inputTokens: 100,
        outputTokens: 50,
        effectiveModel: 'anthropic.claude-haiku-4-5-20251001-v1:0',
      });
      redis.incrByFloat.mockResolvedValueOnce(0.001);

      const out = await service.callBedrock(
        'why is this wrong?',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
        { userId: 'user-1', jobId: 'job-1', maxTokens: 1024 },
      );

      expect(bedrock.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
          userPrompt: 'why is this wrong?',
          maxTokens: 1024,
        }),
      );
      // Note: jobId is currently accepted by logUsage but not persisted —
      // the AiUsageLog entity doesn't have a jobId column yet. Track the
      // fields that actually land in the table.
      expect(usage.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          model: 'anthropic.claude-haiku-4-5-20251001-v1:0',
          inputTokens: 100,
          outputTokens: 50,
        }),
      );
      expect(redis.incrByFloat).toHaveBeenCalled();
      expect(out.content).toBe('an explanation');
      expect(out.contentHtml).toContain('<p>');
      expect(out.costUsd).toBeGreaterThan(0);
    });

    it('defaults action to EXPLANATION when caller did not pass one', async () => {
      bedrock.invoke.mockResolvedValueOnce({
        text: 'x',
        inputTokens: 1,
        outputTokens: 1,
        effectiveModel: 'anthropic.claude-haiku-4-5-20251001-v1:0',
      });
      await service.callBedrock(
        'p',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
      );
      expect(usage.insert).toHaveBeenCalledWith(
        expect.objectContaining({ action: AiAction.EXPLANATION }),
      );
    });

    it('does not throw even if usage logging fails (best-effort instrumentation)', async () => {
      bedrock.invoke.mockResolvedValueOnce({
        text: 'x',
        inputTokens: 1,
        outputTokens: 1,
        effectiveModel: 'anthropic.claude-haiku-4-5-20251001-v1:0',
      });
      usage.insert.mockRejectedValueOnce(new Error('pg down'));
      await expect(
        service.callBedrock('p', 'anthropic.claude-haiku-4-5-20251001-v1:0'),
      ).resolves.toBeDefined();
    });
  });

  // ------------------------- getActivePrompt -------------------------

  describe('getActivePrompt', () => {
    it('returns the active template when one exists', async () => {
      prompts.findOne.mockResolvedValueOnce({
        name: 'explanation_v1',
        isActive: true,
      });
      const out = await service.getActivePrompt('explanation_v1');
      expect(out.name).toBe('explanation_v1');
    });

    it('throws when no active template exists for the name (caller must run seed:prompts)', async () => {
      prompts.findOne.mockResolvedValueOnce(null);
      await expect(service.getActivePrompt('missing')).rejects.toThrow(
        /seed:prompts/,
      );
    });
  });
});
