import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { AiReview } from './entities/ai-review.entity';
import { WeaknessService } from './weakness.service';
import { AiReviewConfigService } from './ai-review-config.service';
import { AiService } from '../ai/ai.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AccountType, AiAction, ExamType } from '../../common/types/enums';
import { accraMonthStartIso } from '../../common/utils/timezone.util';
import {
  buildAiReviewPrompt,
  SYSTEM_SHELL_AI_REVIEW,
} from './ai-review.prompt';
import { validateAiReview } from './ai-review.validator';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import {
  AiReviewFull,
  AiReviewListItem,
  AiReviewQuota,
  toAiReviewFull,
  toAiReviewListItem,
} from './serializers/ai-review.serializer';

/**
 * User-triggered AI Study Review. Never runs on a cron or on read —
 * only `generate()` writes a row, and only when the student asks.
 *
 * Quota model (no carry-forward): the monthly allowance per tier lives
 * in ai_review_config (admin-editable). "Used this month" is a live
 * COUNT of personalised rows created since the start of the current
 * Accra month, so the counter resets on its own at month rollover and
 * unused generations never accumulate. A malformed / empty AI response
 * is never persisted, so it never costs the student a unit.
 */
@Injectable()
export class AiReviewService {
  private readonly logger = new Logger(AiReviewService.name);
  private static readonly MAX_TOKENS = 1200;
  private static readonly ALL_SCOPE = 'all';

  constructor(
    @InjectRepository(AiReview)
    private readonly reviewsRepo: Repository<AiReview>,
    private readonly weakness: WeaknessService,
    private readonly reviewConfig: AiReviewConfigService,
    private readonly ai: AiService,
    private readonly subscriptions: SubscriptionsService,
    private readonly config: ConfigService,
  ) {}

  /** Generate a new review (quota-checked). */
  async generate(
    userId: string,
    examType: ExamType | null | undefined,
    filters: { subjectId?: string },
  ): Promise<{ review: AiReviewFull; quota: AiReviewQuota }> {
    const scope = filters.subjectId ?? AiReviewService.ALL_SCOPE;

    // 1. Gate on tier first — reviews are a Plus/Pro feature, so a Free
    //    caller is refused before we do any work (including the free
    //    bootstrap path, which they can't reach in the UI anyway).
    const tier = await this.resolveTier(userId, examType);
    if (tier === AccountType.FREE) {
      throw new ForbiddenException({
        code: 'AI_REVIEW_REQUIRES_SUBSCRIPTION',
        message:
          'AI Study Reviews are a Plus and Pro feature. Upgrade to generate your personalised review.',
      });
    }

    // 2. Pull weakness signal. Zero-signal students get a canned
    //    bootstrap review — no Bedrock call and, crucially, no quota
    //    charge (mode='bootstrap' rows are excluded from the count).
    const data = await this.weakness.forUser(userId, {
      subjectId: filters.subjectId,
    });
    const hasSignal =
      data.pastPaperWeakTopics.length > 0 || data.syllabusWeakTopics.length > 0;

    if (!hasSignal) {
      const row = await this.reviewsRepo.save(
        this.reviewsRepo.create({
          userId,
          subjectScope: scope,
          content: BOOTSTRAP_REVIEW,
          summary: BOOTSTRAP_SUMMARY,
          mode: 'bootstrap',
          model: 'canned',
        }),
      );
      return {
        review: toAiReviewFull(row),
        quota: await this.quota(userId, examType),
      };
    }

    // 3. Enforce the monthly quota for a real (personalised) generation.
    const limit = await this.monthlyLimitFor(tier);
    const used = await this.usedThisMonth(userId);
    if (used >= limit) {
      throw new ForbiddenException({
        code: 'AI_REVIEW_LIMIT_REACHED',
        message: `You've used all ${limit} AI reviews for this month. Your allowance resets on the 1st.`,
      });
    }

    // 4. Generate + validate. A bad response is NOT persisted, so it
    //    does not consume a unit — the student can simply retry.
    const prompt = buildAiReviewPrompt(
      data.pastPaperWeakTopics,
      data.syllabusWeakTopics,
    );
    const model =
      this.config.get<string>('ai.defaultModel') ??
      'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

    const result = await this.ai.callBedrock(prompt, model, {
      system: SYSTEM_SHELL_AI_REVIEW,
      maxTokens: AiReviewService.MAX_TOKENS,
      action: AiAction.AI_REVIEW,
      userId,
    });

    const validation = validateAiReview(result.content);
    if (!validation.ok) {
      this.logger.warn(
        `[ai-review] rejected user=${userId} reason=${validation.reason} detail=${validation.detail}`,
      );
      throw new BadRequestException(
        'The AI review came back malformed. Please try again in a moment — this attempt was not counted.',
      );
    }

    const row = await this.reviewsRepo.save(
      this.reviewsRepo.create({
        userId,
        subjectScope: scope,
        content: validation.content,
        summary: validation.summary,
        mode: 'personalised',
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd != null ? String(result.costUsd) : null,
      }),
    );

    return {
      review: toAiReviewFull(row),
      quota: await this.quota(userId, examType),
    };
  }

  /** Paginated history, newest first. Light rows (no full content). */
  async history(
    userId: string,
    opts: { page: number; limit: number },
  ): Promise<PaginatedResult<AiReviewListItem>> {
    const [rows, total] = await this.reviewsRepo.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: opts.limit,
      skip: (opts.page - 1) * opts.limit,
    });
    return { items: rows.map(toAiReviewListItem), total };
  }

  /** Full review by id, scoped to the caller. */
  async findOne(userId: string, id: string): Promise<AiReviewFull> {
    const row = await this.reviewsRepo.findOne({ where: { id, userId } });
    if (!row) {
      throw new BadRequestException('Review not found.');
    }
    return toAiReviewFull(row);
  }

  /** Quota snapshot + latest review for the Home card. */
  async quota(
    userId: string,
    examType: ExamType | null | undefined,
  ): Promise<AiReviewQuota> {
    const tier = await this.resolveTier(userId, examType);
    const limit =
      tier === AccountType.FREE ? 0 : await this.monthlyLimitFor(tier);
    const used = await this.usedThisMonth(userId);
    const remaining = Math.max(0, limit - used);

    const latestRow = await this.reviewsRepo.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    return {
      tier:
        tier === AccountType.PRO
          ? 'pro'
          : tier === AccountType.PLUS
            ? 'plus'
            : 'free',
      limit,
      used,
      remaining,
      canGenerate: tier !== AccountType.FREE && remaining > 0,
      latest: latestRow ? toAiReviewListItem(latestRow) : null,
    };
  }

  /**
   * Count personalised reviews created since the start of the current
   * Accra month. Bootstrap rows are free and excluded.
   */
  private async usedThisMonth(userId: string): Promise<number> {
    const monthStart = new Date(`${accraMonthStartIso()}T00:00:00.000Z`);
    return this.reviewsRepo.count({
      where: {
        userId,
        mode: 'personalised',
        createdAt: MoreThanOrEqual(monthStart),
      },
    });
  }

  private async monthlyLimitFor(tier: AccountType): Promise<number> {
    const cfg = await this.reviewConfig.get();
    return tier === AccountType.PRO
      ? cfg.proMonthlyLimit
      : cfg.plusMonthlyLimit;
  }

  private async resolveTier(
    userId: string,
    examType: ExamType | null | undefined,
  ): Promise<AccountType> {
    if (!examType) return AccountType.FREE;
    const ent = await this.subscriptions.entitlementFor(userId, examType);
    return ent.account;
  }
}

/**
 * Canned bootstrap review — served (free, no Bedrock) when the student
 * has no weak-topic signal yet. Same 6-section markdown shape as a real
 * review so the mobile renderer never branches on structure.
 */
const BOOTSTRAP_SUMMARY =
  "You're all set up — do a little practice and your first personalised review will light up with exactly what to work on.";

const BOOTSTRAP_REVIEW = `${BOOTSTRAP_SUMMARY}

## Strengths
You've taken the most important step — you're here and ready to work. That consistency is the foundation everything else builds on.

## Where you're losing marks
We haven't seen enough of your practice yet to pinpoint your weak spots. Once you answer a handful of questions across a topic, the pattern becomes clear.

## Common mistake patterns
Nothing to flag yet — this section fills in once you've attempted a few topics and we can see where the same kind of slip repeats.

## How to approach it
Start broad, then go deep. Pick the subject you feel least confident in and treat your first attempts as a diagnostic, not a test. Read each question twice, and when you get one wrong, note *why* before moving on.

## Your study plan
1. Choose one subject to start with.
2. Do 10–20 mixed questions in it.
3. Come back and generate a fresh review — it will now name your real weak topics and give you a targeted plan.

## This week's focus
Complete one practice set of 10 questions in your least-confident subject. That single set is enough to unlock your first personalised review.`;
