import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThanOrEqual, Repository } from 'typeorm';
import { AccountDeletion } from './entities/account-deletion.entity';
import { User } from '../users/entities/user.entity';
import { DeviceSession } from '../auth/entities/device-session.entity';
import { MailService } from '../mail/mail.service';
import { MailEvent } from '../mail/mail.types';
import {
  AccountDeletionReason,
  AccountDeletionStatus,
  UserRole,
} from '../../common/types/enums';

const DAY_MS = 24 * 3600 * 1000;
/** Total grace before an account is purged. */
const GRACE_DAYS = 90;
/** First heads-up email, N days before deletion. */
const WARN_FIRST_LEAD_DAYS = 14;
/** Final heads-up email, N days before deletion. */
const WARN_FINAL_LEAD_DAYS = 7;
/** Inactivity is scheduled once a user reaches this many days without login. */
const SCHEDULE_AT_INACTIVE_DAYS = GRACE_DAYS - WARN_FIRST_LEAD_DAYS; // 76
/** Cap per sweep step so one run can't stampede the DB / mail queue. */
const BATCH_CAP = 1000;

interface SweepSummary {
  scheduled: number;
  cancelled: number;
  warned: number;
  deleted: number;
  deletedSamples: string[];
}

/**
 * Owns the account-deletion lifecycle (see AccountDeletion entity). Two
 * entry points — a user asking to delete, and the daily inactivity sweep —
 * converge on one queue. At `delete_after` the account is ANONYMISED (not
 * hard-deleted; winners FK-references users with ON DELETE RESTRICT).
 */
@Injectable()
export class AccountDeletionsService {
  private readonly logger = new Logger(AccountDeletionsService.name);

  constructor(
    @InjectRepository(AccountDeletion)
    private readonly deletionsRepo: Repository<AccountDeletion>,
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(DeviceSession)
    private readonly sessionsRepo: Repository<DeviceSession>,
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
  ) {}

  private get webUrl(): string {
    return (process.env.MAIL_WEB_URL ?? 'https://bondzi.online').replace(
      /\/$/,
      '',
    );
  }

  private adminRecipients(): string[] {
    return (process.env.ADMIN_ALERT_EMAIL ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private maskEmail(email: string | null): string {
    if (!email) return '(no email)';
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const head = local.slice(0, 1);
    return `${head}***@${domain}`;
  }

  // ---- User-initiated -----------------------------------------------------

  /**
   * DELETE /users/me. Schedules a 90-day grace, snapshots the current
   * activity time (so any fresh login cancels it), and signs the user out
   * everywhere. Idempotent — an existing schedule is returned as-is.
   */
  async scheduleUserRequested(userId: string): Promise<{ deleteAfter: Date }> {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const existing = await this.deletionsRepo.findOne({
      where: { userId, status: AccountDeletionStatus.SCHEDULED },
    });
    if (existing) {
      await this.revokeSessions(userId);
      return { deleteAfter: existing.deleteAfter };
    }

    const now = new Date();
    const deleteAfter = new Date(now.getTime() + GRACE_DAYS * DAY_MS);
    const row = this.deletionsRepo.create({
      userId,
      reason: AccountDeletionReason.USER_REQUESTED,
      status: AccountDeletionStatus.SCHEDULED,
      deleteAfter,
      // Snapshot "now": any login after this bumps last_active_at past it
      // and the sweep cancels the deletion (recover-by-login).
      referenceActiveAt: now,
    });
    await this.deletionsRepo.save(row);
    // Sign out so their current session stops working — they must
    // deliberately log back in to recover.
    await this.revokeSessions(userId);
    return { deleteAfter };
  }

  /** Cancel a user's pending deletion (e.g. an explicit "undo"). */
  async cancelForUser(userId: string): Promise<void> {
    await this.deletionsRepo.update(
      { userId, status: AccountDeletionStatus.SCHEDULED },
      { status: AccountDeletionStatus.CANCELLED, cancelledAt: new Date() },
    );
  }

  private async revokeSessions(userId: string): Promise<void> {
    await this.sessionsRepo.delete({ userId });
  }

  // ---- Daily sweep --------------------------------------------------------

  async runDailySweep(): Promise<SweepSummary> {
    const summary: SweepSummary = {
      scheduled: 0,
      cancelled: 0,
      warned: 0,
      deleted: 0,
      deletedSamples: [],
    };
    summary.scheduled = await this.scheduleInactive();
    summary.cancelled = await this.cancelRecovered();
    summary.warned = await this.sendWarnings();
    const purge = await this.purgeDue();
    summary.deleted = purge.deleted;
    summary.deletedSamples = purge.samples;

    await this.sendAdminDigest(summary);
    return summary;
  }

  /** Schedule student accounts inactive for ≥76 days (14 days of warning). */
  private async scheduleInactive(): Promise<number> {
    const now = Date.now();
    const cutoff = new Date(now - SCHEDULE_AT_INACTIVE_DAYS * DAY_MS);
    const users = await this.usersRepo
      .createQueryBuilder('u')
      .where('u.is_active = true')
      .andWhere('u.deleted_at IS NULL')
      // Never auto-delete staff accounts — only students.
      .andWhere('u.role = :role', { role: UserRole.STUDENT })
      .andWhere('u.last_active_at IS NOT NULL')
      .andWhere('u.last_active_at <= :cutoff', { cutoff })
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM account_deletions ad
          WHERE ad.user_id = u.id AND ad.status = 'scheduled'
        )`,
      )
      .select(['u.id', 'u.last_active_at'])
      .take(BATCH_CAP)
      .getMany();

    if (users.length === 0) return 0;
    const rows = users.map((u) => {
      const lastActive = u.lastActiveAt ?? new Date(now);
      // Deletion date = last login + 90d, but never sooner than 14 days
      // from now — guarantees every account gets the full warning window,
      // including long-dormant accounts caught on the first run.
      const deleteAfter = new Date(
        Math.max(
          lastActive.getTime() + GRACE_DAYS * DAY_MS,
          now + WARN_FIRST_LEAD_DAYS * DAY_MS,
        ),
      );
      return this.deletionsRepo.create({
        userId: u.id,
        reason: AccountDeletionReason.INACTIVITY,
        status: AccountDeletionStatus.SCHEDULED,
        deleteAfter,
        referenceActiveAt: lastActive,
      });
    });
    await this.deletionsRepo.save(rows);
    if (users.length === BATCH_CAP) {
      this.logger.warn(
        `[acct-del] scheduling hit the ${BATCH_CAP} cap — more inactive accounts remain for the next run`,
      );
    }
    return rows.length;
  }

  /** Cancel schedules where the user logged back in after we snapshotted. */
  private async cancelRecovered(): Promise<number> {
    const recovered = await this.deletionsRepo
      .createQueryBuilder('ad')
      .innerJoin(User, 'u', 'u.id = ad.user_id')
      .where('ad.status = :s', { s: AccountDeletionStatus.SCHEDULED })
      .andWhere('ad.reference_active_at IS NOT NULL')
      .andWhere('u.last_active_at IS NOT NULL')
      .andWhere('u.last_active_at > ad.reference_active_at')
      .select('ad.id', 'id')
      .getRawMany<{ id: string }>();
    if (recovered.length === 0) return 0;
    const now = new Date();
    for (const { id } of recovered) {
      await this.deletionsRepo.update(id, {
        status: AccountDeletionStatus.CANCELLED,
        cancelledAt: now,
      });
    }
    return recovered.length;
  }

  /** Send the T-14 and T-7 heads-up emails. */
  private async sendWarnings(): Promise<number> {
    const now = Date.now();
    let warned = 0;
    warned += await this.sendWarningStage('first', WARN_FIRST_LEAD_DAYS, now);
    warned += await this.sendWarningStage('final', WARN_FINAL_LEAD_DAYS, now);
    return warned;
  }

  private async sendWarningStage(
    stage: 'first' | 'final',
    leadDays: number,
    now: number,
  ): Promise<number> {
    const column = stage === 'first' ? 'warned_first_at' : 'warned_final_at';
    const due = await this.deletionsRepo
      .createQueryBuilder('ad')
      .where('ad.status = :s', { s: AccountDeletionStatus.SCHEDULED })
      .andWhere(`ad.${column} IS NULL`)
      .andWhere('ad.delete_after <= :threshold', {
        threshold: new Date(now + leadDays * DAY_MS),
      })
      .andWhere('ad.delete_after > :now', { now: new Date(now) })
      .take(BATCH_CAP)
      .getMany();

    let sent = 0;
    for (const ad of due) {
      const user = await this.usersRepo.findOne({
        where: { id: ad.userId },
        select: { id: true, email: true, fullName: true },
      });
      if (user?.email) {
        const daysLeft = Math.max(
          1,
          Math.ceil((ad.deleteAfter.getTime() - now) / DAY_MS),
        );
        await this.mail.send(
          MailEvent.ACCOUNT_DELETION_WARNING,
          user.email,
          {
            recipientName: user.fullName,
            daysLeft,
            deleteOnDate: this.formatDate(ad.deleteAfter),
            reason: ad.reason,
            loginUrl: `${this.webUrl}/login`,
          },
          {
            sync: false,
            userId: user.id,
            dedupKey: `acctdel:warn:${stage}:${ad.id}`,
          },
        );
        sent += 1;
      }
      await this.deletionsRepo.update(ad.id, { [column]: new Date(now) });
    }
    return sent;
  }

  /** Anonymise accounts whose grace has elapsed. */
  private async purgeDue(): Promise<{ deleted: number; samples: string[] }> {
    const now = new Date();
    const due = await this.deletionsRepo.find({
      where: {
        status: AccountDeletionStatus.SCHEDULED,
        deleteAfter: LessThanOrEqual(now),
      },
      take: BATCH_CAP,
    });

    let deleted = 0;
    const samples: string[] = [];
    for (const ad of due) {
      const user = await this.usersRepo.findOne({
        where: { id: ad.userId },
        select: {
          id: true,
          email: true,
          fullName: true,
          lastActiveAt: true,
        },
      });
      if (!user) {
        // User row already gone — close the schedule out.
        await this.deletionsRepo.update(ad.id, {
          status: AccountDeletionStatus.COMPLETED,
          completedAt: now,
        });
        continue;
      }
      // Last-second recovery guard: logged in after we snapshotted.
      if (
        ad.referenceActiveAt &&
        user.lastActiveAt &&
        user.lastActiveAt > ad.referenceActiveAt
      ) {
        await this.deletionsRepo.update(ad.id, {
          status: AccountDeletionStatus.CANCELLED,
          cancelledAt: now,
        });
        continue;
      }

      const email = user.email;
      const name = user.fullName;
      await this.anonymize(ad, user.id, now);
      deleted += 1;
      if (samples.length < 20) {
        samples.push(`${ad.reason} · ${this.maskEmail(email)}`);
      }
      if (email) {
        await this.mail.send(
          MailEvent.ACCOUNT_DELETED,
          email,
          { recipientName: name, deletedOnDate: this.formatDate(now) },
          {
            sync: false,
            userId: user.id,
            dedupKey: `acctdel:done:${ad.id}`,
          },
        );
      }
    }
    return { deleted, samples };
  }

  /**
   * Scrub PII, free the username/email/phone, sign out, and stamp
   * deleted_at — all in one transaction. The row survives so leaderboard /
   * winner / XP / referral references stay intact.
   */
  private async anonymize(
    ad: AccountDeletion,
    userId: string,
    now: Date,
  ): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      await em.getRepository(User).update(userId, {
        fullName: 'Deleted user',
        email: null,
        phone: null,
        username: null,
        avatarUrl: null,
        dateOfBirth: null,
        gender: null,
        schoolName: null,
        passwordHash: null,
        currentDeviceId: null,
        isActive: false,
      });
      // Soft-delete stamp (deleted_at) via the @DeleteDateColumn.
      await em.getRepository(User).softDelete(userId);
      await em.getRepository(DeviceSession).delete({ userId });
      await em.getRepository(AccountDeletion).update(ad.id, {
        status: AccountDeletionStatus.COMPLETED,
        completedAt: now,
      });
    });
  }

  private async sendAdminDigest(summary: SweepSummary): Promise<void> {
    const recipients = this.adminRecipients();
    if (recipients.length === 0) return;
    // Nothing happened — stay quiet.
    if (
      summary.scheduled === 0 &&
      summary.warned === 0 &&
      summary.deleted === 0
    ) {
      return;
    }
    const dateKey = new Date().toISOString().slice(0, 10);
    for (const to of recipients) {
      await this.mail.send(
        MailEvent.ADMIN_ACCOUNT_DELETION_DIGEST,
        to,
        {
          dateKey,
          scheduledCount: summary.scheduled,
          warnedCount: summary.warned,
          deletedCount: summary.deleted,
          deletedSamples: summary.deletedSamples,
        },
        { sync: false, dedupKey: `acctdel:digest:${dateKey}:${to}` },
      );
    }
  }

  private formatDate(d: Date): string {
    return d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }
}
