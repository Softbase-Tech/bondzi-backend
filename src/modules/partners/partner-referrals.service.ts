import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerCommissionStatus } from '../../common/types/enums';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { SubscriptionPlanEntity } from '../subscriptions/plans/entities/subscription-plan.entity';
import { User } from '../users/entities/user.entity';
import { PartnerAttribution } from './entities/partner-attribution.entity';
import { PartnerCommission } from './entities/partner-commission.entity';
import { PartnerReferralCode } from './entities/partner-referral-code.entity';

/**
 * One row in the partner's Referrals view. Represents a user attributed
 * to the partner, enriched with engagement + payment + commission
 * summary the partner can act on.
 *
 * Privacy rule (per Q13 decision on the plan doc): show `username`
 * only — never full name, email, or phone. When a referred user has
 * no username set we fall back to a short opaque handle so partners
 * don't confuse two anonymous rows.
 */
export interface PartnerReferralRow {
  userId: string;
  handle: string;
  attributedAt: Date;
  codeId: string;
  code: string;
  codeLabel: string;
  isDefaultCode: boolean;
  answerCount: number;
  engagementBucket: 'new' | 'engaged' | 'committed';
  hasPaidPlus: boolean;
  commissionsEarnedGhs: string;
  commissionsPaidGhs: string;
  commissionStatus:
    | 'none'
    | 'pending'
    | 'approved'
    | 'flagged'
    | 'paid'
    | 'clawed_back';
}

export interface PartnerReferralsResult {
  items: PartnerReferralRow[];
  totals: {
    totalReferrals: number;
    activeUsers: number;
    paidPlus: number;
    earnedGhs: string;
    paidGhs: string;
  };
}

/**
 * Read-only aggregator for the partner-facing Referrals page. Joins
 * five tables in a single request path:
 *
 *   partner_attributions          (base — who's yours)
 *   users                         (handle)
 *   partner_referral_codes        (which code they used)
 *   exams + exam_answers          (engagement bucket)
 *   subscriptions + plans         (paid Plus?)
 *   partner_commissions           (earnings + status per user)
 *
 * Everything runs on the partner's own row set (`partner_id = X`) so
 * there's no cross-partner leak. Reads only — no state changes.
 *
 * Not paginated in this iteration: a partner with hundreds of
 * referrals is rare at launch and in-memory sort/filter beats
 * standing up a paginated join with computed-column ORDER BY. When
 * we hit real-world partners past ~500 referrals we'll add a
 * `page/limit` param.
 */
@Injectable()
export class PartnerReferralsService {
  constructor(
    @InjectRepository(PartnerAttribution)
    private readonly attributionsRepo: Repository<PartnerAttribution>,
    @InjectRepository(PartnerCommission)
    private readonly commissionsRepo: Repository<PartnerCommission>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(PartnerReferralCode)
    private readonly codesRepo: Repository<PartnerReferralCode>,
    @InjectRepository(ExamAnswer)
    private readonly answersRepo: Repository<ExamAnswer>,
    @InjectRepository(Subscription)
    private readonly subsRepo: Repository<Subscription>,
  ) {}

  async listForPartner(input: {
    partnerId: string;
    codeId?: string;
    sort?: 'recent' | 'engaged' | 'earning';
  }): Promise<PartnerReferralsResult> {
    // -------- Step 1: attributions + user + code --------
    const attrQb = this.attributionsRepo
      .createQueryBuilder('a')
      .innerJoin(User, 'u', 'u.id = a.user_id')
      .innerJoin(PartnerReferralCode, 'c', 'c.id = a.partner_referral_code_id')
      .where('a.partner_id = :pid', { pid: input.partnerId });
    if (input.codeId) {
      attrQb.andWhere('a.partner_referral_code_id = :cid', {
        cid: input.codeId,
      });
    }
    const attrRows = await attrQb
      .select([
        'a.user_id AS user_id',
        'a.attributed_at AS attributed_at',
        'a.partner_referral_code_id AS code_id',
        'u.username AS username',
        'c.code AS code',
        'c.label AS code_label',
        'c.is_default AS is_default',
      ])
      .orderBy('a.attributed_at', 'DESC')
      .getRawMany<{
        user_id: string;
        attributed_at: Date;
        code_id: string;
        username: string | null;
        code: string;
        code_label: string;
        is_default: boolean;
      }>();

    if (attrRows.length === 0) {
      return {
        items: [],
        totals: {
          totalReferrals: 0,
          activeUsers: 0,
          paidPlus: 0,
          earnedGhs: '0.00',
          paidGhs: '0.00',
        },
      };
    }

    const userIds = attrRows.map((r) => r.user_id);

    // -------- Step 2: completed-exam answer counts --------
    const answerRows = await this.answersRepo
      .createQueryBuilder('ans')
      .innerJoin(Exam, 'e', "e.id = ans.exam_id AND e.status = 'completed'")
      .where('e.user_id IN (:...uids)', { uids: userIds })
      .select('e.user_id', 'user_id')
      .addSelect('COUNT(ans.id)', 'answer_count')
      .groupBy('e.user_id')
      .getRawMany<{ user_id: string; answer_count: string }>();
    const answerCounts = new Map(
      answerRows.map((r) => [r.user_id, Number(r.answer_count)]),
    );

    // -------- Step 3: active paid Plus per user --------
    const plusRows = await this.subsRepo
      .createQueryBuilder('s')
      .innerJoin(
        SubscriptionPlanEntity,
        'p',
        "p.id = s.plan_id AND p.payment_kind = 'one_time' AND p.account = 'plus'",
      )
      .where('s.user_id IN (:...uids)', { uids: userIds })
      .andWhere(`s.status IN ('active','trial')`)
      .andWhere('(s.expires_at IS NULL OR s.expires_at > NOW())')
      .select('DISTINCT s.user_id', 'user_id')
      .getRawMany<{ user_id: string }>();
    const paidPlusSet = new Set(plusRows.map((r) => r.user_id));

    // -------- Step 4: commissions per user --------
    // Positive-earnings only for the "earned" display (the clawback
    // offset rows have negative amounts and their own type — they
    // shouldn't inflate the per-user earnings number, they're the
    // reversal).
    const commissionRows = await this.commissionsRepo
      .createQueryBuilder('c')
      .where('c.partner_id = :pid', { pid: input.partnerId })
      .andWhere('c.user_id IN (:...uids)', { uids: userIds })
      .andWhere(`c.type <> 'plus_subscription_clawback'`)
      .select('c.user_id', 'user_id')
      .addSelect('c.status', 'status')
      .addSelect('c.amount_ghs', 'amount_ghs')
      .getRawMany<{
        user_id: string;
        status: PartnerCommissionStatus;
        amount_ghs: string;
      }>();
    const commSummary = new Map<
      string,
      {
        earned: number;
        paid: number;
        status: PartnerReferralRow['commissionStatus'];
      }
    >();
    for (const c of commissionRows) {
      const cur = commSummary.get(c.user_id) ?? {
        earned: 0,
        paid: 0,
        status: 'none' as const,
      };
      const amount = Number(c.amount_ghs);
      cur.earned += amount;
      if (c.status === PartnerCommissionStatus.PAID) {
        cur.paid += amount;
      }
      cur.status = mergeStatus(cur.status, c.status);
      commSummary.set(c.user_id, cur);
    }

    // -------- Step 5: assemble + shape --------
    const items: PartnerReferralRow[] = attrRows.map((r) => {
      const answers = answerCounts.get(r.user_id) ?? 0;
      const bucket: PartnerReferralRow['engagementBucket'] =
        answers >= 40 ? 'committed' : answers >= 10 ? 'engaged' : 'new';
      const summ = commSummary.get(r.user_id) ?? {
        earned: 0,
        paid: 0,
        status: 'none' as const,
      };
      return {
        userId: r.user_id,
        handle: r.username ?? `student-${r.user_id.slice(0, 6)}`,
        attributedAt: r.attributed_at,
        codeId: r.code_id,
        code: r.code,
        codeLabel: r.code_label,
        isDefaultCode: r.is_default,
        answerCount: answers,
        engagementBucket: bucket,
        hasPaidPlus: paidPlusSet.has(r.user_id),
        commissionsEarnedGhs: summ.earned.toFixed(2),
        commissionsPaidGhs: summ.paid.toFixed(2),
        commissionStatus: summ.status,
      };
    });

    // -------- Sort --------
    const sort = input.sort ?? 'recent';
    if (sort === 'recent') {
      items.sort((a, b) => b.attributedAt.getTime() - a.attributedAt.getTime());
    } else if (sort === 'engaged') {
      items.sort((a, b) => b.answerCount - a.answerCount);
    } else {
      items.sort(
        (a, b) =>
          Number(b.commissionsEarnedGhs) - Number(a.commissionsEarnedGhs),
      );
    }

    // -------- Totals --------
    const totalReferrals = items.length;
    const activeUsers = items.filter(
      (i) => i.engagementBucket !== 'new',
    ).length;
    const paidPlus = items.filter((i) => i.hasPaidPlus).length;
    const earned = items.reduce(
      (s, i) => s + Number(i.commissionsEarnedGhs),
      0,
    );
    const paid = items.reduce((s, i) => s + Number(i.commissionsPaidGhs), 0);

    return {
      items,
      totals: {
        totalReferrals,
        activeUsers,
        paidPlus,
        earnedGhs: earned.toFixed(2),
        paidGhs: paid.toFixed(2),
      },
    };
  }
}

/**
 * Progression map for commission status per referred user. When a user
 * has multiple commissions in different states, we surface the most-
 * progressed one so the partner sees "some of your money for this
 * user is paid" rather than "some of your money for this user is
 * pending".
 */
function mergeStatus(
  current: PartnerReferralRow['commissionStatus'],
  incoming: PartnerCommissionStatus,
): PartnerReferralRow['commissionStatus'] {
  const rank = (
    s: PartnerReferralRow['commissionStatus'] | PartnerCommissionStatus,
  ): number => {
    switch (s) {
      case PartnerCommissionStatus.PAID:
      case 'paid':
        return 5;
      case PartnerCommissionStatus.APPROVED:
      case 'approved':
        return 4;
      case PartnerCommissionStatus.FLAGGED:
      case 'flagged':
        return 3;
      case PartnerCommissionStatus.PENDING:
      case 'pending':
        return 2;
      case PartnerCommissionStatus.CLAWED_BACK:
      case 'clawed_back':
        return 1;
      default:
        return 0;
    }
  };
  const currentRank = rank(current);
  const incomingRank = rank(incoming);
  if (incomingRank <= currentRank) return current;
  switch (incoming) {
    case PartnerCommissionStatus.PAID:
      return 'paid';
    case PartnerCommissionStatus.APPROVED:
      return 'approved';
    case PartnerCommissionStatus.FLAGGED:
      return 'flagged';
    case PartnerCommissionStatus.PENDING:
      return 'pending';
    case PartnerCommissionStatus.CLAWED_BACK:
      return 'clawed_back';
    default:
      return current;
  }
}
