import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  MomoProvider,
  PartnerCommissionStatus,
  PartnerCommissionType,
  PartnerPayoutStatus,
  PartnerStatus,
} from '../../common/types/enums';
import { MailService } from '../mail/mail.service';
import { PartnerCommission } from './entities/partner-commission.entity';
import { PartnerPayout } from './entities/partner-payout.entity';
import { Partner } from './entities/partner.entity';
import { PartnerPayoutsService } from './partner-payouts.service';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const activePartner = (patch: Partial<Partner> = {}) =>
  ({
    id: 'partner-1',
    userId: 'user-1',
    email: 'k@example.com',
    phone: '+233209000000',
    fullName: 'Kwame Partner',
    countryCode: 'GH',
    momoProvider: MomoProvider.MTN,
    momoNumber: '0209000000',
    momoAccountName: 'Kwame Partner',
    status: PartnerStatus.ACTIVE,
    agreedTermsVersionId: 't1',
    fraudFlagCount: 0,
    ...patch,
  }) as unknown as Partner;

const commission = (patch: Partial<PartnerCommission> = {}) =>
  ({
    id: 'c1',
    partnerId: 'partner-1',
    type: PartnerCommissionType.PLUS_SUBSCRIPTION,
    amountGhs: '30.00',
    currency: 'GHS',
    status: PartnerCommissionStatus.APPROVED,
    earnedAt: new Date('2026-07-15T10:00:00Z'),
    paidOutId: null,
    termsVersionId: 't1',
    subscriptionId: 'sub-a',
    userId: 'referred-1',
    batchUserIds: null,
    flagReason: null,
    flaggedAt: null,
    dedupKey: 'sub-a',
    eligibilityMeta: {},
    ...patch,
  }) as unknown as PartnerCommission;

describe('PartnerPayoutsService', () => {
  let service: PartnerPayoutsService;
  let payoutsRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let commissionsRepo: {
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let partnersRepo: { findOne: jest.Mock };
  let mail: { send: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  // Per-transaction repos:
  let txCommissionsRepo: {
    createQueryBuilder: jest.Mock;
  };
  let txPayoutsRepo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };

  beforeEach(async () => {
    payoutsRepo = {
      findOne: jest.fn(),
      create: jest.fn((o) => o),
      save: jest.fn(async (o) => ({ id: 'payout-1', ...o })),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    commissionsRepo = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    partnersRepo = { findOne: jest.fn().mockResolvedValue(activePartner()) };
    mail = { send: jest.fn().mockResolvedValue(undefined) };

    txCommissionsRepo = {
      createQueryBuilder: jest.fn(),
    };
    txPayoutsRepo = {
      create: jest.fn((o) => o),
      save: jest.fn(async (o) => ({
        id: 'payout-1',
        createdAt: new Date(),
        ...o,
      })),
      findOne: jest.fn(),
    };

    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          async (
            fn: (em: {
              getRepository: (entity: unknown) => unknown;
            }) => Promise<unknown>,
          ) =>
            fn({
              getRepository: (entity: unknown) => {
                if (entity === PartnerCommission) return txCommissionsRepo;
                if (entity === PartnerPayout) return txPayoutsRepo;
                throw new Error(
                  `unexpected em.getRepository(${(entity as { name?: string })?.name ?? String(entity)})`,
                );
              },
            }),
        ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PartnerPayoutsService,
        { provide: getRepositoryToken(PartnerPayout), useValue: payoutsRepo },
        {
          provide: getRepositoryToken(PartnerCommission),
          useValue: commissionsRepo,
        },
        { provide: getRepositoryToken(Partner), useValue: partnersRepo },
        { provide: MailService, useValue: mail },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(PartnerPayoutsService);
  });

  // ==========================================================================
  // previewNextPayout
  // ==========================================================================

  describe('previewNextPayout', () => {
    it('sums approved-and-unpaid commissions', async () => {
      commissionsRepo.find.mockResolvedValueOnce([
        commission({ amountGhs: '30.00' }),
        commission({ amountGhs: '20.00', id: 'c2', dedupKey: 'x' }),
      ]);
      const out = await service.previewNextPayout('partner-1');
      expect(out.totalGhs).toBe('50.00');
      expect(out.commissionCount).toBe(2);
    });

    it('returns 0.00 when there is nothing to pay out', async () => {
      commissionsRepo.find.mockResolvedValueOnce([]);
      const out = await service.previewNextPayout('partner-1');
      expect(out.totalGhs).toBe('0.00');
      expect(out.commissionCount).toBe(0);
    });
  });

  // ==========================================================================
  // createPayout
  // ==========================================================================

  describe('createPayout', () => {
    // Helper to set up the transaction-scoped commission builder.
    function stubEligibleCommissions(rows: PartnerCommission[]) {
      const updateExec = jest.fn().mockResolvedValue({ affected: rows.length });
      txCommissionsRepo.createQueryBuilder.mockImplementation(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        whereInIds: jest.fn().mockReturnThis(),
        execute: updateExec,
      }));
      return { updateExec };
    }

    it('refuses to pay a NON-ACTIVE partner', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(
        activePartner({ status: PartnerStatus.PENDING }),
      );
      await expect(service.createPayout('partner-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses when there are zero approved+unpaid commissions', async () => {
      stubEligibleCommissions([]);
      await expect(service.createPayout('partner-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses when clawbacks bring the balance to <= 0', async () => {
      stubEligibleCommissions([
        commission({ amountGhs: '30.00' }),
        commission({
          id: 'c2',
          type: PartnerCommissionType.PLUS_SUBSCRIPTION_CLAWBACK,
          amountGhs: '-30.00',
          dedupKey: 'x',
        }),
      ]);
      await expect(service.createPayout('partner-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('creates a PENDING payout, snapshots MoMo details, and locks commissions', async () => {
      const { updateExec } = stubEligibleCommissions([
        commission({ amountGhs: '30.00' }),
        commission({ id: 'c2', amountGhs: '20.00', dedupKey: 'x' }),
      ]);
      const out = await service.createPayout('partner-1');
      expect(out.amountGhs).toBe('50.00');
      expect(out.status).toBe(PartnerPayoutStatus.PENDING);
      expect(out.momoProvider).toBe(MomoProvider.MTN);
      expect(out.momoNumber).toBe('0209000000');
      expect(out.invoiceNumber).toMatch(/^INV-\d{8}-[A-Z0-9]{8}$/);
      // Commissions were bulk-updated with the new payout id.
      expect(updateExec).toHaveBeenCalled();
    });

    it('throws NotFoundException on missing partner', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.createPayout('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ==========================================================================
  // markPaid
  // ==========================================================================

  describe('markPaid', () => {
    it('flips PENDING → PAID, stamps admin + reference + timestamp, sends email', async () => {
      const pending = {
        id: 'payout-1',
        partnerId: 'partner-1',
        status: PartnerPayoutStatus.PENDING,
        momoProvider: MomoProvider.MTN,
        momoNumber: '0209000000',
        invoiceNumber: 'INV-20260801-ABCDEFGH',
        amountGhs: '50.00',
        weekOf: '2026-07-27',
        markedPaidBy: null,
        markedPaidAt: null,
        momoReference: null,
        notes: null,
        createdAt: new Date(),
      };
      payoutsRepo.findOne.mockResolvedValueOnce(pending);
      // Reload for the mail-dispatch path
      commissionsRepo.find.mockResolvedValueOnce([
        commission({ amountGhs: '30.00' }),
        commission({ id: 'c2', amountGhs: '20.00', dedupKey: 'x' }),
      ]);
      // Inside the transaction
      txPayoutsRepo.findOne.mockResolvedValueOnce({ ...pending });
      txPayoutsRepo.save.mockImplementationOnce(async (o) => o);
      // Commission bulk-update
      const updateExec = jest.fn().mockResolvedValue({ affected: 2 });
      txCommissionsRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: updateExec,
      });

      const out = await service.markPaid({
        payoutId: 'payout-1',
        adminUserId: 'admin-1',
        momoReference: 'MOMO-REF-999',
      });

      expect(out.status).toBe(PartnerPayoutStatus.PAID);
      expect(out.momoReference).toBe('MOMO-REF-999');
      expect(out.markedPaidBy).toBe('admin-1');
      expect(updateExec).toHaveBeenCalled();
      // Payout email dispatched with attachment + correct event.
      expect(mail.send).toHaveBeenCalledTimes(1);
      const [event, to, payload, options] = mail.send.mock.calls[0];
      expect(event).toBe('partner_payout_paid');
      expect(to).toBe('k@example.com');
      expect(payload.amountDisplay).toBe('50.00');
      expect(payload.momoReference).toBe('MOMO-REF-999');
      expect(options.attachments).toHaveLength(1);
      expect(options.attachments[0].contentType).toBe('application/pdf');
    });

    it('is idempotent — a re-mark of an already-PAID payout returns without side effects', async () => {
      payoutsRepo.findOne.mockResolvedValueOnce({
        id: 'payout-1',
        status: PartnerPayoutStatus.PAID,
      });
      const out = await service.markPaid({
        payoutId: 'payout-1',
        adminUserId: 'admin-1',
        momoReference: 'X',
      });
      expect(out.status).toBe(PartnerPayoutStatus.PAID);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('rejects an empty momoReference', async () => {
      payoutsRepo.findOne.mockResolvedValueOnce({
        id: 'payout-1',
        status: PartnerPayoutStatus.PENDING,
      });
      await expect(
        service.markPaid({
          payoutId: 'payout-1',
          adminUserId: 'admin-1',
          momoReference: '   ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses FAILED payouts', async () => {
      payoutsRepo.findOne.mockResolvedValueOnce({
        id: 'payout-1',
        status: PartnerPayoutStatus.FAILED,
      });
      await expect(
        service.markPaid({
          payoutId: 'payout-1',
          adminUserId: 'admin-1',
          momoReference: 'X',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ==========================================================================
  // markFailed
  // ==========================================================================

  describe('markFailed', () => {
    it('flips PENDING → FAILED and reverts commissions to APPROVED', async () => {
      const pending = {
        id: 'payout-1',
        partnerId: 'partner-1',
        status: PartnerPayoutStatus.PENDING,
        notes: null,
      };
      payoutsRepo.findOne.mockResolvedValueOnce(pending);
      txPayoutsRepo.findOne.mockResolvedValueOnce({ ...pending });
      const updateExec = jest.fn().mockResolvedValue({ affected: 3 });
      txCommissionsRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: updateExec,
      });
      const out = await service.markFailed({
        payoutId: 'payout-1',
        adminUserId: 'admin-2',
        reason: 'MoMo bounce',
      });
      expect(out.status).toBe(PartnerPayoutStatus.FAILED);
      expect(out.notes).toContain('MoMo bounce');
      expect(updateExec).toHaveBeenCalled();
    });

    it('refuses to double-fail', async () => {
      payoutsRepo.findOne.mockResolvedValueOnce({
        id: 'payout-1',
        status: PartnerPayoutStatus.FAILED,
      });
      await expect(
        service.markFailed({
          payoutId: 'payout-1',
          adminUserId: 'admin-2',
          reason: 'x',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
