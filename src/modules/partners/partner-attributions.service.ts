import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import {
  PartnerAttributionSource,
  PartnerFraudEventType,
  PartnerFraudSeverity,
  PartnerStatus,
} from '../../common/types/enums';
import { DeviceSession } from '../auth/entities/device-session.entity';
import { User } from '../users/entities/user.entity';
import { PartnerAttribution } from './entities/partner-attribution.entity';
import { PartnerFraudEvent } from './entities/partner-fraud-event.entity';
import { Partner } from './entities/partner.entity';
import { PartnersService } from './partners.service';

/**
 * Attribution flags. Each string is one detection rule; multiple can
 * fire on the same attribution and all get stored on the row.
 */
const FLAG = {
  SAME_DEVICE: 'same_device',
  SAME_PHONE_ROOT: 'same_phone_root',
  SAME_EMAIL_ROOT: 'same_email_root',
  SELF_REFERRAL: 'self_referral',
  ATTRIBUTION_BURST: 'attribution_burst',
} as const;

/** How many attributions in the last hour is "too many". */
const BURST_WINDOW_MINUTES = 60;
const BURST_MAX = 10;

const HIGH = new Set<string>([FLAG.SELF_REFERRAL, FLAG.SAME_DEVICE]);
const MEDIUM = new Set<string>([FLAG.ATTRIBUTION_BURST, FLAG.SAME_PHONE_ROOT]);

/**
 * PartnerAttributionsService — the single write-site that links a
 * user to a partner. Called from:
 *
 *   - AuthService.register (partnerReferralCode field)
 *   - later, banner-click landing (cookie-based)
 *   - later, admin dashboard (manual attribution)
 *
 * Idempotency: `partner_attributions.user_id` is UNIQUE at the DB
 * layer. Double-invocation on the same user resolves to the existing
 * row (no throw).
 *
 * Fraud checks run at attribution time; each triggered rule writes a
 * string into `suspicion_flags` AND a `partner_fraud_events` row.
 * The commissions engine (Phase 2) checks the attribution's flags
 * before moving a credit out of `flagged`. Three high/medium fraud
 * events trip the auto-block counter on the partner (§7.3 of the
 * plan doc).
 */
@Injectable()
export class PartnerAttributionsService {
  private readonly logger = new Logger(PartnerAttributionsService.name);

  constructor(
    @InjectRepository(PartnerAttribution)
    private readonly attrRepo: Repository<PartnerAttribution>,
    @InjectRepository(PartnerFraudEvent)
    private readonly fraudRepo: Repository<PartnerFraudEvent>,
    @InjectRepository(Partner)
    private readonly partnersRepo: Repository<Partner>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(DeviceSession)
    private readonly sessionsRepo: Repository<DeviceSession>,
    private readonly partnersService: PartnersService,
  ) {}

  /**
   * Attribute a freshly-registered user to a partner referral code.
   *
   * Returns the attribution row (existing or new). Never throws on
   * unknown code / suspended partner / duplicate attribution —
   * caller is the register flow, which should not fail because of a
   * malformed referral. Fraud flags are still recorded.
   */
  async attributeFromRegister(input: {
    user: User;
    code: string;
    deviceId?: string;
  }): Promise<PartnerAttribution | null> {
    return this.attribute({
      user: input.user,
      code: input.code,
      deviceId: input.deviceId,
      source: PartnerAttributionSource.REGISTER_CODE,
    });
  }

  /**
   * Generic attribution write-site. `source` distinguishes register
   * vs banner vs admin-manual for audit purposes.
   */
  async attribute(input: {
    user: User;
    code: string;
    deviceId?: string;
    source: PartnerAttributionSource;
    actorId?: string;
  }): Promise<PartnerAttribution | null> {
    const rawCode = input.code?.trim().toUpperCase();
    if (!rawCode) return null;

    // Existing attribution wins — one partner per user, ever.
    const existing = await this.attrRepo.findOne({
      where: { userId: input.user.id },
    });
    if (existing) return existing;

    const code = await this.partnersService.findActiveCode(rawCode);
    if (!code) {
      this.logger.warn(
        `[partner-attr] unknown or inactive code ${rawCode} at register user=${input.user.id}`,
      );
      return null;
    }

    const partner = await this.partnersRepo.findOne({
      where: { id: code.partnerId },
    });
    if (!partner || partner.status === PartnerStatus.BANNED) {
      this.logger.warn(
        `[partner-attr] partner ${code.partnerId} unavailable (${
          partner?.status ?? 'missing'
        }) at register user=${input.user.id}`,
      );
      return null;
    }

    const flags = await this.detectFraud({
      newUser: input.user,
      partner,
      deviceId: input.deviceId,
    });

    const attribution = this.attrRepo.create({
      userId: input.user.id,
      partnerId: partner.id,
      partnerReferralCodeId: code.id,
      attributionSource: input.source,
      attributedAt: new Date(),
      suspicionFlags: flags,
      createdBy: input.actorId ?? null,
    });

    // If two writes race the same user_id, one hits the UNIQUE index
    // and throws — swallow and return the winner's row.
    let saved: PartnerAttribution;
    try {
      saved = await this.attrRepo.save(attribution);
    } catch (err) {
      const winner = await this.attrRepo.findOne({
        where: { userId: input.user.id },
      });
      if (winner) return winner;
      throw err;
    }

    // Persist fraud events for each triggered rule.
    if (flags.length > 0) {
      await this.recordFraudEvents(partner.id, saved.id, flags);
    }

    return saved;
  }

  // --------------------------------------------------------------------
  // Fraud detection
  // --------------------------------------------------------------------

  private async detectFraud(input: {
    newUser: User;
    partner: Partner;
    deviceId?: string;
  }): Promise<string[]> {
    const flags: string[] = [];

    // Self-referral: the partner is trying to attribute themselves.
    if (input.partner.userId && input.partner.userId === input.newUser.id) {
      flags.push(FLAG.SELF_REFERRAL);
    }

    // Device sharing: the referred user's device_id currently hosts
    // an active session for the partner's user account (or vice
    // versa). Only meaningful when the partner is a student too.
    if (input.deviceId && input.partner.userId) {
      const sameDevice = await this.sessionsRepo.findOne({
        where: {
          userId: input.partner.userId,
          deviceId: input.deviceId,
        },
      });
      if (sameDevice) flags.push(FLAG.SAME_DEVICE);
    }

    // Same phone root — last 7 digits collide.
    const partnerPhoneRoot = trimPhoneRoot(input.partner.phone);
    const userPhoneRoot = trimPhoneRoot(input.newUser.phone ?? '');
    if (
      partnerPhoneRoot &&
      userPhoneRoot &&
      partnerPhoneRoot === userPhoneRoot
    ) {
      flags.push(FLAG.SAME_PHONE_ROOT);
    }

    // Same email local-part (case-insensitive).
    const partnerEmailRoot = emailLocalPart(input.partner.email);
    const userEmailRoot = emailLocalPart(input.newUser.email ?? '');
    if (
      partnerEmailRoot &&
      userEmailRoot &&
      partnerEmailRoot === userEmailRoot
    ) {
      flags.push(FLAG.SAME_EMAIL_ROOT);
    }

    // Attribution burst: partner has attributed too many users in
    // the recent past.
    const windowStart = new Date(Date.now() - BURST_WINDOW_MINUTES * 60_000);
    const recent = await this.attrRepo.count({
      where: {
        partnerId: input.partner.id,
        attributedAt: MoreThanOrEqual(windowStart),
      },
    });
    if (recent >= BURST_MAX) {
      flags.push(FLAG.ATTRIBUTION_BURST);
    }

    return flags;
  }

  /**
   * Persist a fraud_events row per flag AND increment
   * partners.fraud_flag_count for high/medium severity flags. When
   * the count crosses the terms-version threshold, the partner flips
   * to `suspended`. Actual suspension enforcement (blocking payouts,
   * showing the banner on the partner dashboard) happens in Phase 5.
   */
  private async recordFraudEvents(
    partnerId: string,
    attributionId: string,
    flags: string[],
  ): Promise<void> {
    for (const flag of flags) {
      await this.fraudRepo.save(
        this.fraudRepo.create({
          partnerId,
          type: PartnerFraudEventType.ATTRIBUTION_FLAG,
          severity: this.severityFor(flag),
          subjectRef: attributionId,
          reason: flag,
        }),
      );
    }

    // Only high + medium bump the auto-block counter. LOW severity
    // (same_email_root) is logged but doesn't count against the
    // strike allowance.
    const bump = flags.filter((f) => HIGH.has(f) || MEDIUM.has(f)).length;
    if (bump > 0) {
      await this.partnersRepo.increment(
        { id: partnerId },
        'fraudFlagCount',
        bump,
      );
    }
  }

  private severityFor(flag: string): PartnerFraudSeverity {
    if (HIGH.has(flag)) return PartnerFraudSeverity.HIGH;
    if (MEDIUM.has(flag)) return PartnerFraudSeverity.MEDIUM;
    return PartnerFraudSeverity.LOW;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimPhoneRoot(phone: string): string {
  const digits = (phone ?? '').replace(/\D+/g, '');
  if (digits.length < 7) return '';
  return digits.slice(-7);
}

function emailLocalPart(email: string): string {
  const at = (email ?? '').indexOf('@');
  if (at <= 0) return '';
  return (email ?? '').slice(0, at).trim().toLowerCase();
}
