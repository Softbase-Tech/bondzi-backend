import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  PartnerCommissionStatus,
  PartnerStatus,
} from '../../common/types/enums';
import { MailService } from '../mail/mail.service';
import { PartnerAttribution } from './entities/partner-attribution.entity';
import { PartnerCommission } from './entities/partner-commission.entity';
import { PartnerFraudEvent } from './entities/partner-fraud-event.entity';
import { PartnerPayout } from './entities/partner-payout.entity';
import { PartnerReferralCode } from './entities/partner-referral-code.entity';
import { Partner } from './entities/partner.entity';
import { PartnersAdminService } from './partners-admin.service';

describe('PartnersAdminService', () => {
  let service: PartnersAdminService;
  let partnersRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let codesRepo: { findOne: jest.Mock };
  let attributionsRepo: { count: jest.Mock };
  let commissionsRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let payoutsRepo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
  };
  let mail: { send: jest.Mock; getWebUrl: jest.Mock };

  const activePartner = (patch: Partial<Partner> = {}) =>
    ({
      id: 'partner-1',
      userId: 'user-1',
      email: 'k@example.com',
      fullName: 'Kwame',
      status: PartnerStatus.ACTIVE,
      ...patch,
    }) as unknown as Partner;

  beforeEach(async () => {
    partnersRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (o) => o),
      createQueryBuilder: jest.fn(),
    };
    codesRepo = { findOne: jest.fn().mockResolvedValue(null) };
    attributionsRepo = { count: jest.fn().mockResolvedValue(0) };
    commissionsRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn(async (o) => o),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      }),
    };
    payoutsRepo = { createQueryBuilder: jest.fn(), findOne: jest.fn() };
    mail = {
      send: jest.fn().mockResolvedValue(undefined),
      getWebUrl: jest.fn().mockReturnValue('https://bondzi.app'),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PartnersAdminService,
        { provide: getRepositoryToken(Partner), useValue: partnersRepo },
        {
          provide: getRepositoryToken(PartnerReferralCode),
          useValue: codesRepo,
        },
        {
          provide: getRepositoryToken(PartnerAttribution),
          useValue: attributionsRepo,
        },
        {
          provide: getRepositoryToken(PartnerCommission),
          useValue: commissionsRepo,
        },
        { provide: getRepositoryToken(PartnerPayout), useValue: payoutsRepo },
        {
          provide: getRepositoryToken(PartnerFraudEvent),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn(async (o) => o),
            createQueryBuilder: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              take: jest.fn().mockReturnThis(),
              skip: jest.fn().mockReturnThis(),
              getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
            }),
          },
        },
        { provide: MailService, useValue: mail },
        {
          provide: DataSource,
          useValue: {
            transaction: jest
              .fn()
              .mockImplementation(async (fn: (em: unknown) => unknown) =>
                fn({
                  getRepository: () => ({
                    save: jest.fn(async (o) => o),
                    createQueryBuilder: jest.fn().mockReturnValue({
                      update: jest.fn().mockReturnThis(),
                      set: jest.fn().mockReturnThis(),
                      where: jest.fn().mockReturnThis(),
                      andWhere: jest.fn().mockReturnThis(),
                      execute: jest.fn().mockResolvedValue({ affected: 0 }),
                    }),
                  }),
                }),
              ),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(PartnersAdminService);
  });

  // ==========================================================================
  // approvePartner
  // ==========================================================================

  describe('approvePartner', () => {
    it('flips PENDING → ACTIVE, snapshots approver, sends the approval email', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(
        activePartner({ status: PartnerStatus.PENDING }),
      );
      codesRepo.findOne.mockResolvedValueOnce({
        id: 'code-1',
        partnerId: 'partner-1',
        code: 'ABC1234',
        isDefault: true,
      });
      const out = await service.approvePartner({
        partnerId: 'partner-1',
        adminUserId: 'admin-1',
      });
      expect(out.status).toBe(PartnerStatus.ACTIVE);
      expect(out.approvedBy).toBe('admin-1');
      expect(out.approvedAt).toBeInstanceOf(Date);
      // Best-effort email: the return isn't awaited but the mock IS
      // called synchronously by our stub — so a microtask flush is
      // enough. Wait one tick.
      await new Promise((r) => setImmediate(r));
      expect(mail.send).toHaveBeenCalled();
      const [, to, payload] = mail.send.mock.calls[0];
      expect(to).toBe('k@example.com');
      expect(payload.defaultCode).toBe('ABC1234');
    });

    it('is idempotent on already-ACTIVE partners', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(activePartner());
      const out = await service.approvePartner({
        partnerId: 'partner-1',
        adminUserId: 'admin-1',
      });
      expect(out.status).toBe(PartnerStatus.ACTIVE);
      // No save (nothing changed), no email.
      expect(partnersRepo.save).not.toHaveBeenCalled();
    });

    it('refuses SUSPENDED / BANNED', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(
        activePartner({ status: PartnerStatus.SUSPENDED }),
      );
      await expect(
        service.approvePartner({ partnerId: 'partner-1', adminUserId: 'a' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing partner throws NotFoundException', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.approvePartner({ partnerId: 'missing', adminUserId: 'a' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ==========================================================================
  // suspendPartner
  // ==========================================================================

  describe('suspendPartner', () => {
    it('flips ACTIVE → SUSPENDED and stamps suspendedAt', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(activePartner());
      const out = await service.suspendPartner({
        partnerId: 'partner-1',
        adminUserId: 'admin-1',
        reason: 'fraud queue',
      });
      expect(out.status).toBe(PartnerStatus.SUSPENDED);
      expect(out.suspendedAt).toBeInstanceOf(Date);
    });

    it('refuses to suspend a BANNED partner', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(
        activePartner({ status: PartnerStatus.BANNED }),
      );
      await expect(
        service.suspendPartner({
          partnerId: 'partner-1',
          adminUserId: 'a',
          reason: 'x',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ==========================================================================
  // resolveFlaggedCommission
  // ==========================================================================

  describe('resolveFlaggedCommission', () => {
    it('flips FLAGGED → APPROVED on decision=approve and stamps admin metadata', async () => {
      commissionsRepo.findOne.mockResolvedValueOnce({
        id: 'c1',
        status: PartnerCommissionStatus.FLAGGED,
        eligibilityMeta: {},
      });
      const out = await service.resolveFlaggedCommission({
        commissionId: 'c1',
        adminUserId: 'admin-1',
        decision: 'approve',
        note: 'looked clean',
      });
      expect(out.status).toBe(PartnerCommissionStatus.APPROVED);
      expect(out.eligibilityMeta?.resolvedBy).toBe('admin-1');
      expect(out.eligibilityMeta?.resolveDecision).toBe('approve');
    });

    it('flips FLAGGED → CLAWED_BACK on decision=clawback', async () => {
      commissionsRepo.findOne.mockResolvedValueOnce({
        id: 'c1',
        status: PartnerCommissionStatus.FLAGGED,
        eligibilityMeta: {},
      });
      const out = await service.resolveFlaggedCommission({
        commissionId: 'c1',
        adminUserId: 'admin-1',
        decision: 'clawback',
      });
      expect(out.status).toBe(PartnerCommissionStatus.CLAWED_BACK);
    });

    it('refuses to resolve a non-FLAGGED commission', async () => {
      commissionsRepo.findOne.mockResolvedValueOnce({
        id: 'c1',
        status: PartnerCommissionStatus.APPROVED,
      });
      await expect(
        service.resolveFlaggedCommission({
          commissionId: 'c1',
          adminUserId: 'a',
          decision: 'approve',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ==========================================================================
  // banPartner
  // ==========================================================================

  describe('banPartner', () => {
    it('is idempotent on already-banned partners', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(
        activePartner({ status: PartnerStatus.BANNED }),
      );
      const out = await service.banPartner({
        partnerId: 'partner-1',
        adminUserId: 'admin-1',
        reason: 'x',
      });
      expect(out.status).toBe(PartnerStatus.BANNED);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('flips ACTIVE → BANNED, forfeits outstanding, sends the ban email', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(activePartner());
      const out = await service.banPartner({
        partnerId: 'partner-1',
        adminUserId: 'admin-1',
        reason: 'severe fraud pattern',
      });
      expect(out.status).toBe(PartnerStatus.BANNED);
      expect(out.bannedAt).toBeInstanceOf(Date);
      await new Promise((r) => setImmediate(r));
      expect(mail.send).toHaveBeenCalled();
      const [event, to, payload] = mail.send.mock.calls[0];
      expect(event).toBe('partner_account_banned');
      expect(to).toBe('k@example.com');
      expect(payload.reason).toBe('severe fraud pattern');
    });

    it('throws NotFoundException on missing partner', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.banPartner({
          partnerId: 'missing',
          adminUserId: 'a',
          reason: 'x',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ==========================================================================
  // getPartnerDetail
  // ==========================================================================

  describe('getPartnerDetail', () => {
    it('sums approved-unpaid + paid + returns default code + attribution count', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(activePartner());
      codesRepo.findOne.mockResolvedValueOnce({
        id: 'code-1',
        code: 'DEFAULT1',
        isDefault: true,
      });
      attributionsRepo.count.mockResolvedValueOnce(42);
      commissionsRepo.find
        .mockResolvedValueOnce([
          { id: 'c1', amountGhs: '30.00' },
          { id: 'c2', amountGhs: '20.00' },
        ])
        .mockResolvedValueOnce([
          { id: 'c3', amountGhs: '30.00' },
          { id: 'c4', amountGhs: '30.00' },
          { id: 'c5', amountGhs: '30.00' },
        ]);
      const out = await service.getPartnerDetail('partner-1');
      expect(out.attributionsCount).toBe(42);
      expect(out.approvedUnpaidGhs).toBe('50.00');
      expect(out.totalPaidGhs).toBe('90.00');
      expect(out.paidCommissionCount).toBe(3);
      expect(out.defaultCode?.code).toBe('DEFAULT1');
    });
  });
});
