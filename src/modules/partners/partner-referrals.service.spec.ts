import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  PartnerCommissionStatus,
  PartnerCommissionType,
} from '../../common/types/enums';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { User } from '../users/entities/user.entity';
import { PartnerAttribution } from './entities/partner-attribution.entity';
import { PartnerCommission } from './entities/partner-commission.entity';
import { PartnerReferralCode } from './entities/partner-referral-code.entity';
import { PartnerReferralsService } from './partner-referrals.service';

describe('PartnerReferralsService', () => {
  let service: PartnerReferralsService;
  let attributionsRepo: { createQueryBuilder: jest.Mock };
  let commissionsRepo: { createQueryBuilder: jest.Mock };
  let answersRepo: { createQueryBuilder: jest.Mock };
  let subsRepo: { createQueryBuilder: jest.Mock };

  // Individual query builders per repo — assigned per-test.
  let attrQb: {
    innerJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    select: jest.Mock;
    orderBy: jest.Mock;
    getRawMany: jest.Mock;
  };
  let answerQb: {
    innerJoin: jest.Mock;
    where: jest.Mock;
    select: jest.Mock;
    addSelect: jest.Mock;
    groupBy: jest.Mock;
    getRawMany: jest.Mock;
  };
  let subQb: {
    innerJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    select: jest.Mock;
    getRawMany: jest.Mock;
  };
  let commissionQb: {
    where: jest.Mock;
    andWhere: jest.Mock;
    select: jest.Mock;
    addSelect: jest.Mock;
    getRawMany: jest.Mock;
  };

  beforeEach(async () => {
    attrQb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    answerQb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    subQb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    commissionQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    attributionsRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(attrQb),
    };
    commissionsRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(commissionQb),
    };
    answersRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(answerQb),
    };
    subsRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(subQb),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PartnerReferralsService,
        {
          provide: getRepositoryToken(PartnerAttribution),
          useValue: attributionsRepo,
        },
        {
          provide: getRepositoryToken(PartnerCommission),
          useValue: commissionsRepo,
        },
        { provide: getRepositoryToken(User), useValue: {} },
        { provide: getRepositoryToken(PartnerReferralCode), useValue: {} },
        { provide: getRepositoryToken(ExamAnswer), useValue: answersRepo },
        { provide: getRepositoryToken(Subscription), useValue: subsRepo },
      ],
    }).compile();
    service = moduleRef.get(PartnerReferralsService);
  });

  it('returns empty result + zero totals for a partner with no referrals', async () => {
    attrQb.getRawMany.mockResolvedValueOnce([]);
    const out = await service.listForPartner({ partnerId: 'p1' });
    expect(out.items).toEqual([]);
    expect(out.totals).toEqual({
      totalReferrals: 0,
      activeUsers: 0,
      paidPlus: 0,
      earnedGhs: '0.00',
      paidGhs: '0.00',
    });
    // Skipped the join queries — no user_ids to look up.
    expect(answerQb.getRawMany).not.toHaveBeenCalled();
    expect(subQb.getRawMany).not.toHaveBeenCalled();
    expect(commissionQb.getRawMany).not.toHaveBeenCalled();
  });

  it('assembles per-user rows with engagement + paid-Plus + commission summary', async () => {
    const now = new Date('2026-08-10T10:00:00.000Z');
    attrQb.getRawMany.mockResolvedValueOnce([
      {
        user_id: 'u-1',
        attributed_at: now,
        code_id: 'c-1',
        username: 'kwame7ghn',
        code: '2AA7KWA',
        code_label: 'Default code',
        is_default: true,
      },
      {
        user_id: 'u-2',
        attributed_at: new Date('2026-08-05T10:00:00.000Z'),
        code_id: 'c-1',
        username: null,
        code: '2AA7KWA',
        code_label: 'Default code',
        is_default: true,
      },
      {
        user_id: 'u-3',
        attributed_at: new Date('2026-08-01T10:00:00.000Z'),
        code_id: 'c-2',
        username: 'ama',
        code: '9F1BKWA',
        code_label: 'Instagram Feb',
        is_default: false,
      },
    ]);
    answerQb.getRawMany.mockResolvedValueOnce([
      { user_id: 'u-1', answer_count: '55' }, // committed
      { user_id: 'u-2', answer_count: '18' }, // engaged
      // u-3 not in the map → 0 answers → new
    ]);
    subQb.getRawMany.mockResolvedValueOnce([{ user_id: 'u-1' }]);
    commissionQb.getRawMany.mockResolvedValueOnce([
      {
        user_id: 'u-1',
        status: PartnerCommissionStatus.PAID,
        amount_ghs: '30.00',
      },
      {
        user_id: 'u-2',
        status: PartnerCommissionStatus.APPROVED,
        amount_ghs: '2.00',
      },
    ]);

    const out = await service.listForPartner({ partnerId: 'p1' });
    expect(out.items).toHaveLength(3);

    const u1 = out.items.find((r) => r.userId === 'u-1')!;
    expect(u1.handle).toBe('kwame7ghn');
    expect(u1.engagementBucket).toBe('committed');
    expect(u1.hasPaidPlus).toBe(true);
    expect(u1.commissionsEarnedGhs).toBe('30.00');
    expect(u1.commissionsPaidGhs).toBe('30.00');
    expect(u1.commissionStatus).toBe('paid');

    const u2 = out.items.find((r) => r.userId === 'u-2')!;
    expect(u2.handle).toBe('student-u-2'); // fallback for null username
    expect(u2.engagementBucket).toBe('engaged');
    expect(u2.hasPaidPlus).toBe(false);
    expect(u2.commissionsEarnedGhs).toBe('2.00');
    expect(u2.commissionsPaidGhs).toBe('0.00');
    expect(u2.commissionStatus).toBe('approved');

    const u3 = out.items.find((r) => r.userId === 'u-3')!;
    expect(u3.engagementBucket).toBe('new');
    expect(u3.hasPaidPlus).toBe(false);
    expect(u3.commissionStatus).toBe('none');
    expect(u3.commissionsEarnedGhs).toBe('0.00');

    expect(out.totals).toEqual({
      totalReferrals: 3,
      activeUsers: 2, // u-1 committed + u-2 engaged
      paidPlus: 1, // u-1
      earnedGhs: '32.00',
      paidGhs: '30.00',
    });
  });

  it('applies codeId filter to the attribution query', async () => {
    attrQb.getRawMany.mockResolvedValueOnce([]);
    await service.listForPartner({ partnerId: 'p1', codeId: 'c-2' });
    // Second andWhere call is the code filter (first is the base
    // where('a.partner_id = :pid') → wait, that's `where`. So the
    // codeId adds a single andWhere.
    expect(attrQb.andWhere).toHaveBeenCalledWith(
      'a.partner_referral_code_id = :cid',
      { cid: 'c-2' },
    );
  });

  it('sorts by attributedAt DESC for sort=recent (default)', async () => {
    attrQb.getRawMany.mockResolvedValueOnce([
      {
        user_id: 'u-old',
        attributed_at: new Date('2026-07-01T00:00:00.000Z'),
        code_id: 'c-1',
        username: 'old',
        code: 'X',
        code_label: 'X',
        is_default: true,
      },
      {
        user_id: 'u-new',
        attributed_at: new Date('2026-08-10T00:00:00.000Z'),
        code_id: 'c-1',
        username: 'new',
        code: 'X',
        code_label: 'X',
        is_default: true,
      },
    ]);
    const out = await service.listForPartner({ partnerId: 'p1' });
    expect(out.items[0].userId).toBe('u-new');
    expect(out.items[1].userId).toBe('u-old');
  });

  it('sorts by answerCount DESC for sort=engaged', async () => {
    attrQb.getRawMany.mockResolvedValueOnce([
      {
        user_id: 'u-1',
        attributed_at: new Date(),
        code_id: 'c',
        username: 'a',
        code: 'X',
        code_label: 'X',
        is_default: true,
      },
      {
        user_id: 'u-2',
        attributed_at: new Date(),
        code_id: 'c',
        username: 'b',
        code: 'X',
        code_label: 'X',
        is_default: true,
      },
    ]);
    answerQb.getRawMany.mockResolvedValueOnce([
      { user_id: 'u-1', answer_count: '5' },
      { user_id: 'u-2', answer_count: '90' },
    ]);
    const out = await service.listForPartner({
      partnerId: 'p1',
      sort: 'engaged',
    });
    expect(out.items[0].userId).toBe('u-2');
    expect(out.items[1].userId).toBe('u-1');
  });

  it('excludes clawback offset rows from the earnings sum', async () => {
    attrQb.getRawMany.mockResolvedValueOnce([
      {
        user_id: 'u-1',
        attributed_at: new Date(),
        code_id: 'c',
        username: 'a',
        code: 'X',
        code_label: 'X',
        is_default: true,
      },
    ]);
    commissionQb.getRawMany.mockResolvedValueOnce([
      {
        user_id: 'u-1',
        status: PartnerCommissionStatus.APPROVED,
        amount_ghs: '30.00',
      },
      // Note: the service filters out plus_subscription_clawback via
      // `c.type <> 'plus_subscription_clawback'` in the SQL where.
      // We assert here that our query builder call includes that
      // filter, protecting the invariant.
    ]);
    await service.listForPartner({ partnerId: 'p1' });
    expect(commissionQb.andWhere).toHaveBeenCalledWith(
      "c.type <> 'plus_subscription_clawback'",
    );
    void PartnerCommissionType; // keep enum reference for future assertion changes
  });
});
