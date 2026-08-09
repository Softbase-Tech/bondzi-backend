import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AccountType,
  EntitlementAuditAction,
  ExamType,
  NotificationChannel,
  PaymentKind,
  SubscriptionStatus,
} from '../../common/types/enums';
import { AuditLog } from '../admin/entities/audit-log.entity';
import { Subscription } from './entities/subscription.entity';
import { SubscriptionPlanEntity } from './plans/entities/subscription-plan.entity';
import { SubscriptionsService } from './subscriptions.service';
import {
  GrantEntitlementDto,
  RevokeEntitlementDto,
} from './dto/entitlement-admin.dto';
import { User } from '../users/entities/user.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';

/**
 * Admin entitlement service. Centralises the manual grant / revoke /
 * audit-read flows so the controller stays thin and the SubscriptionsService
 * doesn't get a `manualGrant` method that loosens its self-service
 * surface.
 *
 * Why we reuse `audit_log` instead of a new table:
 *
 *   The existing `audit_log` already records admin actions across the
 *   product (question creates, user bans, plan price changes). Adding
 *   a parallel `entitlement_audit` table would split admin forensics
 *   across two systems for no real win — the `entity_type` +
 *   `entity_id` + JSONB `oldValue/newValue` shape is rich enough to
 *   express "admin X granted Pro until 2026-12-31 on WASSCE for user Y
 *   because Z" without a new schema.
 *
 *   We tag rows with `entity_type='subscription'` and reserved `action`
 *   values from `EntitlementAuditAction`:
 *     `entitlement.grant`   — manual grant by admin
 *     `entitlement.revoke`  — manual cancel by admin
 *     `entitlement.extend`  — manual expires_at extension
 *     `entitlement.refund`  — manual REFUNDED flip
 */
@Injectable()
export class EntitlementsAdminService {
  private readonly logger = new Logger(EntitlementsAdminService.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
    @InjectRepository(SubscriptionPlanEntity)
    private readonly plansRepo: Repository<SubscriptionPlanEntity>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly subs: SubscriptionsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  /**
   * Snapshot of a user's effective entitlement across all levels. Returns
   * one row per level — Free is included as the implicit default so the
   * admin UI can render a complete picture without filtering nulls.
   */
  async entitlementsForUser(userId: string): Promise<
    Array<{
      level: ExamType;
      account: AccountType;
      expiresAt: Date | null;
      subscriptionId: string | null;
    }>
  > {
    const levels = Object.values(ExamType);
    return Promise.all(
      levels.map(async (level) => {
        const ent = await this.subs.entitlementFor(userId, level);
        return {
          level,
          account: ent.account,
          expiresAt: ent.expiresAt,
          subscriptionId: ent.subscriptionId,
        };
      }),
    );
  }

  /**
   * Audit trail for one user's entitlement changes. Pulls every
   * `audit_log` row tagged with `entity_type='subscription'` where the
   * subscription's user_id matches. Latest first.
   */
  async auditForUser(userId: string): Promise<AuditLog[]> {
    return this.auditRepo
      .createQueryBuilder('a')
      .innerJoin(
        Subscription,
        's',
        's.id::text = a.entity_id::text AND s.user_id = :uid',
        { uid: userId },
      )
      .where("a.entity_type = 'subscription'")
      .orderBy('a.created_at', 'DESC')
      .take(100)
      .getMany();
  }

  /**
   * Grant Plus or Pro to a user on the specified level. Writes a new
   * subscription row keyed to the default plan for that
   * (country, account, level) slot, in `status=ACTIVE` with
   * `provider='manual'` and a synthetic `provider_reference` so it can
   * never collide with a real Paystack-driven row.
   */
  async grant(
    adminId: string,
    dto: GrantEntitlementDto,
  ): Promise<Subscription> {
    // The DTO already narrows account to PLUS | PRO at the type level,
    // but the runtime payload could still smuggle 'free' through a
    // hand-crafted request. Re-check before touching the catalogue.
    if ((dto.account as AccountType) === AccountType.FREE) {
      throw new BadRequestException(
        'Free is never granted manually — revoke any paid entitlement on this level instead.',
      );
    }
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    if (dto.account === AccountType.PLUS && expiresAt) {
      throw new BadRequestException('Plus is lifetime — omit expiresAt.');
    }
    if (dto.account === AccountType.PRO && !expiresAt) {
      throw new BadRequestException(
        'Pro requires an explicit expiresAt timestamp.',
      );
    }
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('expiresAt must be in the future.');
    }

    // Find the canonical default plan for the (account, level) slot so
    // the manual grant looks identical to a Paystack-driven one (same
    // plan_id, same account / level on the joined row). Manual grants
    // without a backing plan would break the entitlementFor join.
    const plan = await this.plansRepo.findOne({
      where: {
        account: dto.account,
        level: dto.level,
        isActive: true,
        isDefault: true,
      },
    });
    if (!plan) {
      throw new NotFoundException(
        `No active default plan exists for ${dto.account} × ${dto.level}. Create one in the plans admin first.`,
      );
    }

    const sub = this.subsRepo.create({
      userId: dto.userId,
      planId: plan.id,
      // No billing_interval — manual grants don't ride a Paystack
      // cadence. The entitlement resolver only cares about status +
      // expires_at + plan join, so a NULL interval is fine.
      billingInterval: null,
      provider: 'manual',
      providerReference: `manual:${adminId}:${dto.userId}:${dto.level}:${Date.now()}`,
      status: SubscriptionStatus.ACTIVE,
      startsAt: new Date(),
      expiresAt,
      countryCode: plan.countryCode,
      amountGhs: null,
    });
    const saved = await this.subsRepo.save(sub);
    await this.subs.invalidateCache(dto.userId);

    await this.writeAudit(
      adminId,
      EntitlementAuditAction.GRANT,
      saved.id,
      null,
      this.snapshot(saved, plan),
      dto.reason,
    );
    this.logger.log(
      `[entitlement-admin] grant by ${adminId}: user=${dto.userId} level=${dto.level} account=${dto.account}`,
    );

    // Notify the user — push + email — so a manual grant doesn't
    // arrive silently. Both dispatches are best-effort: a Firebase
    // or Resend outage must not roll back the grant itself (the
    // audit row already records it for ops). Each catches its own
    // errors to keep them independent.
    await this.notifyGrant(saved, plan, dto.reason);

    return saved;
  }

  /**
   * Side-effect of `grant`: push + email to the credited user.
   * Centralised so the same routine fires on any future grant call
   * site (e.g. promo-redemption / partnership ingest jobs).
   */
  private async notifyGrant(
    sub: Subscription,
    plan: SubscriptionPlanEntity,
    adminNote: string | undefined,
  ): Promise<void> {
    const user = await this.usersRepo.findOne({ where: { id: sub.userId } });
    if (!user) return;

    const accountLabel = plan.account === AccountType.PRO ? 'Pro' : 'Plus';
    const levelLabel = plan.level.toUpperCase();
    const validUntil = sub.expiresAt
      ? sub.expiresAt.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : 'Lifetime';

    // Push first (instant in-app surface), email second (durable
    // record). Each in its own try/catch so a failure on one side
    // doesn't suppress the other.
    await this.notifications
      .send({
        userId: user.id,
        channel: NotificationChannel.PUSH,
        title: `${accountLabel} unlocked on ${levelLabel}`,
        body: adminNote
          ? `${adminNote.slice(0, 110)}`
          : `Our team has credited your account. Tap to start using premium features.`,
        data: {
          type: 'account_credited',
          account: plan.account,
          level: plan.level,
          subscriptionId: sub.id,
        },
      })
      .catch((err) =>
        this.logger.warn(
          `[entitlement-admin] push notify failed for user=${user.id}: ${(err as Error).message}`,
        ),
      );

    if (user.email) {
      await this.mail
        .send(
          MailEvent.ACCOUNT_CREDITED,
          user.email,
          {
            recipientName: user.fullName.split(' ')[0],
            account: accountLabel,
            level: levelLabel,
            validUntil,
            adminNote: adminNote?.slice(0, 500),
          },
          { userId: user.id },
        )
        .catch((err) =>
          this.logger.warn(
            `[entitlement-admin] email notify failed for user=${user.id}: ${(err as Error).message}`,
          ),
        );
    }
  }

  /**
   * Revoke an active entitlement for the (user, level) pair. By default
   * flips to CANCELLED; with `refund=true` flips to REFUNDED.
   *
   * We resolve the live entitlement via the same path the user-facing
   * code uses (`entitlementFor`) so the admin can never accidentally
   * revoke an expired row.
   */
  async revoke(
    adminId: string,
    dto: RevokeEntitlementDto,
  ): Promise<Subscription> {
    const ent = await this.subs.entitlementFor(dto.userId, dto.level);
    if (!ent.subscriptionId) {
      throw new NotFoundException(
        `No active entitlement found for user × ${dto.level}.`,
      );
    }
    const sub = await this.subsRepo.findOne({
      where: { id: ent.subscriptionId },
    });
    if (!sub) {
      throw new NotFoundException(
        `Subscription ${ent.subscriptionId} disappeared between lookup and revoke.`,
      );
    }
    if (
      sub.status === SubscriptionStatus.CANCELLED ||
      sub.status === SubscriptionStatus.REFUNDED ||
      sub.status === SubscriptionStatus.EXPIRED
    ) {
      throw new ConflictException(
        `Subscription is already ${sub.status} — nothing to revoke.`,
      );
    }
    const before = this.snapshot(sub, null);
    sub.status = dto.refund
      ? SubscriptionStatus.REFUNDED
      : SubscriptionStatus.CANCELLED;
    const saved = await this.subsRepo.save(sub);
    await this.subs.invalidateCache(dto.userId);

    await this.writeAudit(
      adminId,
      dto.refund
        ? EntitlementAuditAction.REFUND
        : EntitlementAuditAction.REVOKE,
      saved.id,
      before,
      this.snapshot(saved, null),
      dto.reason,
    );
    this.logger.log(
      `[entitlement-admin] ${dto.refund ? 'refund' : 'revoke'} by ${adminId}: user=${dto.userId} level=${dto.level} sub=${saved.id}`,
    );
    return saved;
  }

  /**
   * Compact JSON view of a subscription row for audit storage. Drops
   * the FK-only fields and includes the plan's account/level/payment_kind
   * when known so the audit log is readable without joining.
   */
  private snapshot(
    sub: Subscription,
    plan: SubscriptionPlanEntity | null,
  ): Record<string, unknown> {
    return {
      id: sub.id,
      userId: sub.userId,
      planId: sub.planId,
      status: sub.status,
      provider: sub.provider,
      providerReference: sub.providerReference,
      billingInterval: sub.billingInterval,
      amountGhs: sub.amountGhs,
      startsAt: sub.startsAt?.toISOString() ?? null,
      expiresAt: sub.expiresAt?.toISOString() ?? null,
      // Plan-side fields included as a snapshot so a later plan edit
      // doesn't change what the audit row meant at write-time.
      plan: plan
        ? {
            name: plan.name,
            account: plan.account,
            level: plan.level,
            paymentKind: plan.paymentKind,
          }
        : null,
    };
  }

  private async writeAudit(
    adminId: string,
    action: EntitlementAuditAction,
    subscriptionId: string,
    oldValue: Record<string, unknown> | null,
    newValue: Record<string, unknown> | null,
    reason: string,
  ): Promise<void> {
    await this.auditRepo.save(
      this.auditRepo.create({
        adminId,
        action: `entitlement.${action}`,
        entityType: 'subscription',
        entityId: subscriptionId,
        oldValue,
        newValue: newValue ? { ...newValue, reason } : { reason },
      }),
    );
  }
}

// Surface PaymentKind so wedge consumers (e.g. future grant logic that
// branches on the plan's kind for billing-interval defaults) don't need
// to re-import from the central enums. Currently unused inside this
// service but kept here to signal the dependency to readers.
void PaymentKind;
