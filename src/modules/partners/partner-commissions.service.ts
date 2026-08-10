import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  PartnerCommissionStatus,
  PartnerCommissionType,
  PartnerStatus,
  PaymentKind,
} from '../../common/types/enums';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { SubscriptionPlanEntity } from '../subscriptions/plans/entities/subscription-plan.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { User } from '../users/entities/user.entity';
import { PartnerAttribution } from './entities/partner-attribution.entity';
import { PartnerCommission } from './entities/partner-commission.entity';
import { PartnerSignupCredit } from './entities/partner-signup-credit.entity';
import { PartnerTermsVersion } from './entities/partner-terms-version.entity';
import { Partner } from './entities/partner.entity';
import { PartnerTermsService } from './partner-terms.service';

/**
 * Postgres UNIQUE_VIOLATION SQLSTATE. Thrown by TypeORM as a
 * QueryFailedError whose `.driverError.code` (or `.code`) is '23505'.
 * We use it to treat commission-insert races as no-ops instead of
 * hard failures.
 */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * PartnerCommissionsService — the money-making side of the partner
 * portal.
 *
 * Three earning streams + one clawback path:
 *
 *   A) creditPlusSubscription(subscription)
 *        Fires when a Plus subscription activates. Pays
 *        terms.plus_wassce / plus_novdec / plus_bece to the attributed
 *        partner, gated on:
 *          - the user has an attribution row
 *          - the partner is not banned
 *          - the subscription activated within
 *            terms.attribution_window_days of the user registering
 *          - the plan is one-time (Plus), not recurring (Pro)
 *
 *   B) tickSignupProgress(userId)
 *        Fires when a user completes an exam. Once the user's total
 *        completed-exam answers cross terms.signup_min_completed_answers
 *        (default 40), we insert a `partner_signup_credits` row for
 *        the attributed partner. When the partner accumulates
 *        terms.signup_batch_size (default 10) unbatched credits,
 *        `tryCloseBatch` writes a single `signup_batch` commission
 *        worth terms.signup_batch_amount_ghs (default 20 GHC).
 *
 *   C) tickAnswersBonus(userId)
 *        Fires when a user completes an exam. If the user has an
 *        active PAID Plus subscription AND has answered ≥
 *        terms.answers_bonus_threshold (default 100) questions in
 *        completed exams, pay the partner terms.answers_bonus_amount_ghs
 *        (default 2 GHC). One-shot per user; dedup on user_id +
 *        threshold ensures re-entry is a no-op.
 *
 *   Clawback) clawback(subscriptionId)
 *        Fires when a Plus subscription is refunded. If the original
 *        Plus commission is still in {pending, approved, flagged},
 *        flip it to `clawed_back`. If it was already `paid` (partner
 *        got the money), insert a NEGATIVE offset commission
 *        (type = plus_subscription_clawback, amount = -X) so the
 *        partner's future earnings net against the reversed one.
 *
 * Every write is idempotent at the DB layer:
 *   - partner_commissions has UNIQUE (partner_id, type, dedup_key)
 *   - partner_signup_credits has UNIQUE (partner_id, user_id)
 *
 * A repeated call for the same triggering event is absorbed by the
 * unique constraint — we catch 23505 and return without touching the
 * pre-existing row. This is what keeps re-tries (webhook replay,
 * post-crash repair reads, mobile double-submit) from double-paying a
 * partner.
 */
@Injectable()
export class PartnerCommissionsService {
  private readonly logger = new Logger(PartnerCommissionsService.name);

  constructor(
    @InjectRepository(PartnerCommission)
    private readonly commissionsRepo: Repository<PartnerCommission>,
    @InjectRepository(PartnerAttribution)
    private readonly attrsRepo: Repository<PartnerAttribution>,
    @InjectRepository(PartnerSignupCredit)
    private readonly creditsRepo: Repository<PartnerSignupCredit>,
    @InjectRepository(Partner)
    private readonly partnersRepo: Repository<Partner>,
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
    @InjectRepository(SubscriptionPlanEntity)
    private readonly plansRepo: Repository<SubscriptionPlanEntity>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(Exam)
    private readonly examsRepo: Repository<Exam>,
    @InjectRepository(ExamAnswer)
    private readonly answersRepo: Repository<ExamAnswer>,
    private readonly terms: PartnerTermsService,
    private readonly dataSource: DataSource,
  ) {}

  // ==========================================================================
  // Stream A — Plus subscription commission
  // ==========================================================================

  /**
   * Credit the attributed partner for a Plus subscription activation.
   * Returns the created commission, or `null` when no commission was
   * written (unattributed user, banned partner, out-of-window, plan
   * mismatch, or duplicate hit on the unique index).
   *
   * Called from SubscriptionsService.consumePaidAttempt right after
   * the fresh Plus subscription row saves — kept out of the private
   * method's transactional path so a partner-side failure never rolls
   * back a legitimate paid subscription. Wraps the whole thing in a
   * try/catch that only logs; the subscription must succeed regardless.
   */
  async creditPlusSubscription(
    subscriptionId: string,
  ): Promise<PartnerCommission | null> {
    try {
      const subscription = await this.subsRepo.findOne({
        where: { id: subscriptionId },
      });
      if (!subscription) {
        this.logger.warn(
          `[commissions.creditPlusSubscription] subscription ${subscriptionId} missing`,
        );
        return null;
      }
      // Guard against calls for Pro / XP-credited / renewal rows.
      // Plus is the ONLY commissionable subscription per §4 of the plan.
      if (!subscription.planId) return null;
      const plan = await this.plansRepo.findOne({
        where: { id: subscription.planId },
      });
      if (!plan || plan.paymentKind !== PaymentKind.ONE_TIME) return null;

      const attribution = await this.attrsRepo.findOne({
        where: { userId: subscription.userId },
      });
      if (!attribution) return null;

      const partner = await this.partnersRepo.findOne({
        where: { id: attribution.partnerId },
      });
      if (!partner || partner.status === PartnerStatus.BANNED) {
        this.logger.log(
          `[commissions.creditPlusSubscription] skip partner=${
            attribution.partnerId
          } status=${partner?.status ?? 'missing'}`,
        );
        return null;
      }

      const termsVersion = await this.terms.getCurrent();

      // Attribution window: subscription must have activated within
      // terms.attribution_window_days of the user registering. Users
      // paying after the window keep their entitlement — but the
      // partner earned nothing (the user made their own decision by
      // that point).
      const user = await this.usersRepo.findOne({
        where: { id: subscription.userId },
      });
      const registeredAt = user?.createdAt ?? null;
      const activatedAt = subscription.startsAt ?? subscription.createdAt;
      if (registeredAt) {
        const cutoff = new Date(registeredAt);
        cutoff.setDate(cutoff.getDate() + termsVersion.attributionWindowDays);
        if (activatedAt > cutoff) {
          this.logger.log(
            `[commissions.creditPlusSubscription] out-of-window user=${
              subscription.userId
            } registered=${registeredAt.toISOString()} activated=${activatedAt.toISOString()} window=${
              termsVersion.attributionWindowDays
            }d`,
          );
          return null;
        }
      }

      const amountGhs = amountForLevel(termsVersion, plan.level);
      if (amountGhs === null) {
        this.logger.warn(
          `[commissions.creditPlusSubscription] no terms amount for level=${plan.level}`,
        );
        return null;
      }

      // Flagged attributions land in `flagged` — admin must resolve
      // (approve → moves to `approved` or clawback → `clawed_back`)
      // before the partner ever sees the money.
      const status =
        attribution.suspicionFlags.length > 0
          ? PartnerCommissionStatus.FLAGGED
          : partner.status === PartnerStatus.SUSPENDED
            ? PartnerCommissionStatus.PENDING
            : partner.status === PartnerStatus.ACTIVE
              ? PartnerCommissionStatus.APPROVED
              : PartnerCommissionStatus.PENDING;

      return await this.insertCommissionIdempotent({
        partnerId: partner.id,
        type: PartnerCommissionType.PLUS_SUBSCRIPTION,
        amountGhs,
        dedupKey: subscription.id,
        subscriptionId: subscription.id,
        userId: subscription.userId,
        termsVersionId: termsVersion.id,
        status,
        flagReason:
          attribution.suspicionFlags.length > 0
            ? attribution.suspicionFlags.join(',')
            : null,
        eligibilityMeta: {
          level: plan.level,
          amountSource: `plus_${plan.level}`,
          activatedAt: activatedAt.toISOString(),
          registeredAt: registeredAt?.toISOString() ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `[commissions.creditPlusSubscription] threw sub=${subscriptionId}: ${
          (err as Error).message
        }`,
      );
      return null;
    }
  }

  // ==========================================================================
  // Stream B — Signup batch commission (via per-user credit rows)
  // ==========================================================================

  /**
   * Called after an exam session completes. If the user has now
   * crossed the answer-count threshold AND is attributed to a
   * partner AND doesn't already have a signup credit row for that
   * partner, insert one. Then try to close a batch.
   *
   * Also swallows all its own errors — an exam completion must never
   * fail because a partner-side write threw.
   */
  async tickSignupProgress(userId: string): Promise<void> {
    try {
      const attribution = await this.attrsRepo.findOne({ where: { userId } });
      if (!attribution) return;

      const partner = await this.partnersRepo.findOne({
        where: { id: attribution.partnerId },
      });
      if (!partner || partner.status === PartnerStatus.BANNED) return;

      const existingCredit = await this.creditsRepo.findOne({
        where: { partnerId: partner.id, userId },
      });
      if (existingCredit) {
        // Already counted — still nudge tryCloseBatch in case the
        // partner already had 10 sitting and something (a crash, a
        // retry) prevented the earlier close.
        await this.tryCloseBatch(partner.id);
        return;
      }

      const termsVersion = await this.terms.getCurrent();
      const answerCount = await this.countCompletedAnswers(userId);
      if (answerCount < termsVersion.signupMinCompletedAnswers) return;

      try {
        await this.creditsRepo.save(
          this.creditsRepo.create({
            partnerId: partner.id,
            userId,
            batchedCommissionId: null,
          }),
        );
      } catch (err) {
        if (!this.isUniqueViolation(err)) throw err;
        // Two exam completions raced for the same (partner, user).
        // The other one won; we're done. Still fall through to
        // tryCloseBatch — the credit exists either way.
      }

      await this.tryCloseBatch(partner.id);
    } catch (err) {
      this.logger.error(
        `[commissions.tickSignupProgress] threw user=${userId}: ${
          (err as Error).message
        }`,
      );
    }
  }

  /**
   * Pull up to `signup_batch_size` unbatched signup credits for a
   * partner, group them into one signup_batch commission, and stamp
   * every credit with the new commission id.
   *
   * Runs inside a transaction with a FOR UPDATE lock on the credit
   * rows so two concurrent close attempts can't split the same 10
   * credits across two commissions (which would trigger the unique
   * constraint on `dedup_key`).
   *
   * Amount is stamped from the CURRENT terms version at close time,
   * not the version each individual credit was earned under — the
   * plan doc §4.2 explicitly ties the payout amount to the batching
   * moment, so terms edits mid-batch apply to the pending pool.
   */
  private async tryCloseBatch(partnerId: string): Promise<void> {
    const termsVersion = await this.terms.getCurrent();
    const batchSize = termsVersion.signupBatchSize;

    await this.dataSource.transaction(async (em) => {
      // FOR UPDATE SKIP LOCKED so a second worker calling tryCloseBatch
      // on the same partner won't stall behind us — it just sees an
      // empty slice and no-ops.
      const rows = await em
        .getRepository(PartnerSignupCredit)
        .createQueryBuilder('c')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('c.partner_id = :pid', { pid: partnerId })
        .andWhere('c.batched_commission_id IS NULL')
        .orderBy('c.qualified_at', 'ASC')
        .limit(batchSize)
        .getMany();

      if (rows.length < batchSize) return;

      const batchIds = rows.map((r) => r.userId).sort();
      const dedupKey = batchIds.join(',');

      const inserted = await this.insertCommissionInEm(em, {
        partnerId,
        type: PartnerCommissionType.SIGNUP_BATCH,
        amountGhs: termsVersion.signupBatchAmountGhs,
        dedupKey,
        subscriptionId: null,
        userId: null,
        termsVersionId: termsVersion.id,
        status: PartnerCommissionStatus.APPROVED,
        flagReason: null,
        eligibilityMeta: {
          batchSize: rows.length,
          userIds: batchIds,
        },
        batchUserIds: batchIds,
      });
      if (!inserted) {
        // Someone else got here first with the same batch — release the
        // lock, they own it.
        return;
      }

      await em
        .getRepository(PartnerSignupCredit)
        .createQueryBuilder()
        .update()
        .set({ batchedCommissionId: inserted.id })
        .whereInIds(rows.map((r) => r.id))
        .execute();
    });
  }

  // ==========================================================================
  // Stream C — Answers bonus commission
  // ==========================================================================

  /**
   * Called after an exam completion. Pays a one-off answers_bonus if
   * the referred user is a paid-Plus holder AND has crossed the
   * answers threshold. One-shot per user; dedup_key encodes the
   * threshold that was in force when the bonus fired.
   */
  async tickAnswersBonus(userId: string): Promise<void> {
    try {
      const attribution = await this.attrsRepo.findOne({ where: { userId } });
      if (!attribution) return;

      const partner = await this.partnersRepo.findOne({
        where: { id: attribution.partnerId },
      });
      if (!partner || partner.status === PartnerStatus.BANNED) return;

      // Answers bonus is gated on the referred user actually paying
      // for Plus — a free student answering 100 questions doesn't
      // trigger a partner payout under the plan doc §4.3.
      const paidPlus = await this.subsRepo
        .createQueryBuilder('s')
        .innerJoin(
          SubscriptionPlanEntity,
          'p',
          `p.id = s.plan_id AND p.account = 'plus' AND p.payment_kind = 'one_time'`,
        )
        .where('s.user_id = :uid', { uid: userId })
        .andWhere(`s.status IN ('active','trial')`)
        .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
        .getOne();
      if (!paidPlus) return;

      const termsVersion = await this.terms.getCurrent();
      const answerCount = await this.countCompletedAnswers(userId);
      if (answerCount < termsVersion.answersBonusThreshold) return;

      const status =
        attribution.suspicionFlags.length > 0
          ? PartnerCommissionStatus.FLAGGED
          : partner.status === PartnerStatus.SUSPENDED
            ? PartnerCommissionStatus.PENDING
            : PartnerCommissionStatus.APPROVED;

      await this.insertCommissionIdempotent({
        partnerId: partner.id,
        type: PartnerCommissionType.ANSWERS_BONUS,
        amountGhs: termsVersion.answersBonusAmountGhs,
        // dedup_key = "<user>:<threshold>" — retriggering with a
        // different threshold (admin edit) writes a fresh bonus,
        // while re-entry at the same threshold is absorbed.
        dedupKey: `${userId}:${termsVersion.answersBonusThreshold}`,
        subscriptionId: null,
        userId,
        termsVersionId: termsVersion.id,
        status,
        flagReason:
          attribution.suspicionFlags.length > 0
            ? attribution.suspicionFlags.join(',')
            : null,
        eligibilityMeta: {
          answerCount,
          threshold: termsVersion.answersBonusThreshold,
        },
      });
    } catch (err) {
      this.logger.error(
        `[commissions.tickAnswersBonus] threw user=${userId}: ${
          (err as Error).message
        }`,
      );
    }
  }

  // ==========================================================================
  // Clawback — Plus refund reversal
  // ==========================================================================

  /**
   * Reverse the Plus commission tied to `subscriptionId` after a
   * refund. Behaviour depends on the commission's current status:
   *
   *   pending / approved / flagged → flip to `clawed_back`. The
   *     partner never got paid; nothing else to do.
   *
   *   paid → flip to `clawed_back` AND insert a NEGATIVE-amount
   *     `plus_subscription_clawback` commission worth -X. The
   *     partner already got X into their MoMo; the offset sits in
   *     the ledger and nets against future positive earnings.
   *
   *   clawed_back → no-op (already reversed).
   */
  async clawback(
    subscriptionId: string,
    reason: string,
  ): Promise<PartnerCommission | null> {
    try {
      const original = await this.commissionsRepo.findOne({
        where: {
          subscriptionId,
          type: PartnerCommissionType.PLUS_SUBSCRIPTION,
        },
      });
      if (!original) return null;
      if (original.status === PartnerCommissionStatus.CLAWED_BACK) return null;

      const wasPaid = original.status === PartnerCommissionStatus.PAID;

      original.status = PartnerCommissionStatus.CLAWED_BACK;
      original.eligibilityMeta = {
        ...(original.eligibilityMeta ?? {}),
        clawbackReason: reason,
      };
      await this.commissionsRepo.save(original);

      if (!wasPaid) return original;

      // Partner already got the cash. Write the offset. Same
      // dedup_key as the positive row is safe — different `type`
      // means the composite unique (partner_id, type, dedup_key)
      // doesn't collide.
      const termsVersion = await this.terms.findById(original.termsVersionId);
      const negativeAmount = `-${original.amountGhs}`;
      return await this.insertCommissionIdempotent({
        partnerId: original.partnerId,
        type: PartnerCommissionType.PLUS_SUBSCRIPTION_CLAWBACK,
        amountGhs: negativeAmount,
        dedupKey: subscriptionId,
        subscriptionId,
        userId: original.userId,
        termsVersionId: termsVersion.id,
        status: PartnerCommissionStatus.APPROVED,
        flagReason: null,
        eligibilityMeta: {
          offsetOfCommissionId: original.id,
          reason,
        },
      });
    } catch (err) {
      this.logger.error(
        `[commissions.clawback] threw sub=${subscriptionId}: ${
          (err as Error).message
        }`,
      );
      return null;
    }
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Insert a commission row, treating a UNIQUE-violation on
   * (partner_id, type, dedup_key) as a no-op. Returns the inserted
   * row on success, or `null` when the DB refused as duplicate.
   */
  private async insertCommissionIdempotent(input: {
    partnerId: string;
    type: PartnerCommissionType;
    amountGhs: string;
    dedupKey: string;
    subscriptionId: string | null;
    userId: string | null;
    termsVersionId: string;
    status: PartnerCommissionStatus;
    flagReason: string | null;
    eligibilityMeta: Record<string, unknown>;
    batchUserIds?: string[] | null;
  }): Promise<PartnerCommission | null> {
    try {
      return await this.commissionsRepo.save(
        this.commissionsRepo.create({
          partnerId: input.partnerId,
          type: input.type,
          amountGhs: input.amountGhs,
          currency: 'GHS',
          status: input.status,
          earnedAt: new Date(),
          paidOutId: null,
          termsVersionId: input.termsVersionId,
          subscriptionId: input.subscriptionId,
          userId: input.userId,
          batchUserIds: input.batchUserIds ?? null,
          flagReason: input.flagReason,
          flaggedAt:
            input.status === PartnerCommissionStatus.FLAGGED
              ? new Date()
              : null,
          dedupKey: input.dedupKey,
          eligibilityMeta: input.eligibilityMeta,
        }),
      );
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        this.logger.log(
          `[commissions] dedup hit type=${input.type} key=${input.dedupKey} — no-op`,
        );
        return null;
      }
      throw err;
    }
  }

  /**
   * EntityManager-scoped variant of insertCommissionIdempotent used by
   * tryCloseBatch so the commission insert + credit-row updates run
   * in the same transaction.
   */
  private async insertCommissionInEm(
    em: import('typeorm').EntityManager,
    input: {
      partnerId: string;
      type: PartnerCommissionType;
      amountGhs: string;
      dedupKey: string;
      subscriptionId: string | null;
      userId: string | null;
      termsVersionId: string;
      status: PartnerCommissionStatus;
      flagReason: string | null;
      eligibilityMeta: Record<string, unknown>;
      batchUserIds?: string[] | null;
    },
  ): Promise<PartnerCommission | null> {
    try {
      const repo = em.getRepository(PartnerCommission);
      return await repo.save(
        repo.create({
          partnerId: input.partnerId,
          type: input.type,
          amountGhs: input.amountGhs,
          currency: 'GHS',
          status: input.status,
          earnedAt: new Date(),
          paidOutId: null,
          termsVersionId: input.termsVersionId,
          subscriptionId: input.subscriptionId,
          userId: input.userId,
          batchUserIds: input.batchUserIds ?? null,
          flagReason: input.flagReason,
          flaggedAt:
            input.status === PartnerCommissionStatus.FLAGGED
              ? new Date()
              : null,
          dedupKey: input.dedupKey,
          eligibilityMeta: input.eligibilityMeta,
        }),
      );
    } catch (err) {
      if (this.isUniqueViolation(err)) return null;
      throw err;
    }
  }

  /**
   * Count the number of ExamAnswer rows the user has submitted across
   * all COMPLETED exam sessions. Used for both the signup-batch
   * threshold and the answers-bonus threshold.
   */
  private async countCompletedAnswers(userId: string): Promise<number> {
    const raw = await this.answersRepo
      .createQueryBuilder('a')
      .innerJoin(Exam, 'e', 'e.id = a.exam_id')
      .where('e.user_id = :uid', { uid: userId })
      .andWhere(`e.status = 'completed'`)
      .select('COUNT(a.id)', 'c')
      .getRawOne<{ c: string }>();
    return Number(raw?.c ?? 0);
  }

  private isUniqueViolation(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    // TypeORM wraps pg errors as QueryFailedError with `driverError`
    // + a top-level `code`. Belt-and-braces check.
    const asRecord = err as Record<string, unknown>;
    if (asRecord.code === PG_UNIQUE_VIOLATION) return true;
    const driver = asRecord.driverError as { code?: string } | undefined;
    return driver?.code === PG_UNIQUE_VIOLATION;
  }
}

/**
 * Look up the per-level Plus commission amount on a terms version.
 * Returns null if the plan level doesn't map (Free-plan level, or a
 * yet-unmodelled level like 'kindergarten' would land here).
 */
function amountForLevel(
  terms: PartnerTermsVersion,
  level: string,
): string | null {
  switch (level) {
    case 'wassce':
      return terms.plusWassce;
    case 'novdec':
      return terms.plusNovdec;
    case 'bece':
      return terms.plusBece;
    default:
      return null;
  }
}
