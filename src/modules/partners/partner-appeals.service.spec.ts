import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PartnerAppealStatus, PartnerStatus } from '../../common/types/enums';
import { MailService } from '../mail/mail.service';
import { PartnerAppeal } from './entities/partner-appeal.entity';
import { PartnerCommission } from './entities/partner-commission.entity';
import { Partner } from './entities/partner.entity';
import { PartnerAppealsService } from './partner-appeals.service';
import { PartnerTermsService } from './partner-terms.service';

const TERMS = {
  id: 'terms-1',
  version: 1,
  maxAppeals: 3,
  maxFraudFlagsBeforeBlock: 3,
};

const suspendedPartner = (patch: Partial<Partner> = {}) =>
  ({
    id: 'partner-1',
    userId: 'user-1',
    email: 'k@example.com',
    fullName: 'Kwame',
    status: PartnerStatus.SUSPENDED,
    fraudFlagCount: 3,
    suspendedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...patch,
  }) as unknown as Partner;

describe('PartnerAppealsService', () => {
  let service: PartnerAppealsService;
  let appealsRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    findAndCount: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let partnersRepo: { findOne: jest.Mock; save: jest.Mock };
  let commissionsRepo: { createQueryBuilder: jest.Mock };
  let terms: { getCurrent: jest.Mock };
  let mail: { send: jest.Mock; getWebUrl: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  // Per-transaction repos.
  let txAppealsRepo: {
    save: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let txPartnersRepo: { save: jest.Mock };
  let txCommissionsRepo: { createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    appealsRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      save: jest.fn(async (o) => o),
      create: jest.fn((o) => o),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    partnersRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (o) => o),
    };
    commissionsRepo = { createQueryBuilder: jest.fn() };
    terms = { getCurrent: jest.fn().mockResolvedValue(TERMS) };
    mail = {
      send: jest.fn().mockResolvedValue(undefined),
      getWebUrl: jest.fn().mockReturnValue('https://bondzi.app'),
    };

    txAppealsRepo = {
      save: jest.fn(async (o) => ({ id: 'appeal-1', ...o })),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((o) => o),
      createQueryBuilder: jest.fn(),
    };
    txPartnersRepo = { save: jest.fn(async (o) => o) };
    txCommissionsRepo = { createQueryBuilder: jest.fn() };

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
                if (entity === PartnerAppeal) return txAppealsRepo;
                if (entity === Partner) return txPartnersRepo;
                if (entity === PartnerCommission) return txCommissionsRepo;
                throw new Error(
                  `unexpected em.getRepository(${(entity as { name?: string })?.name ?? String(entity)})`,
                );
              },
            }),
        ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PartnerAppealsService,
        { provide: getRepositoryToken(PartnerAppeal), useValue: appealsRepo },
        { provide: getRepositoryToken(Partner), useValue: partnersRepo },
        {
          provide: getRepositoryToken(PartnerCommission),
          useValue: commissionsRepo,
        },
        { provide: PartnerTermsService, useValue: terms },
        { provide: MailService, useValue: mail },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(PartnerAppealsService);
  });

  // ==========================================================================
  // submitAppeal
  // ==========================================================================

  describe('submitAppeal', () => {
    function stubTxLock(rows: PartnerAppeal[]) {
      txAppealsRepo.createQueryBuilder.mockReturnValue({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      });
    }

    it('creates appeal #1 for a suspended partner with no prior appeals', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(suspendedPartner());
      stubTxLock([]);
      const out = await service.submitAppeal({
        partnerId: 'partner-1',
        body: 'x'.repeat(60),
      });
      expect(out.appealNumber).toBe(1);
      expect(out.status).toBe(PartnerAppealStatus.OPEN);
      expect(txAppealsRepo.save).toHaveBeenCalledTimes(1);
    });

    it('increments the appeal number when a prior denied appeal exists', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(suspendedPartner());
      stubTxLock([
        {
          id: 'a1',
          appealNumber: 1,
          status: PartnerAppealStatus.DENIED,
        } as unknown as PartnerAppeal,
      ]);
      const out = await service.submitAppeal({
        partnerId: 'partner-1',
        body: 'x'.repeat(60),
      });
      expect(out.appealNumber).toBe(2);
    });

    it('refuses when an appeal is still OPEN', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(suspendedPartner());
      stubTxLock([
        {
          id: 'a1',
          appealNumber: 1,
          status: PartnerAppealStatus.OPEN,
        } as unknown as PartnerAppeal,
      ]);
      await expect(
        service.submitAppeal({ partnerId: 'partner-1', body: 'x'.repeat(60) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses when the partner has used their appeal allocation', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(suspendedPartner());
      stubTxLock(
        [1, 2, 3].map((n) => ({
          id: `a${n}`,
          appealNumber: n,
          status: PartnerAppealStatus.DENIED,
        })) as unknown as PartnerAppeal[],
      );
      await expect(
        service.submitAppeal({ partnerId: 'partner-1', body: 'x'.repeat(60) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses when the partner is not SUSPENDED', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(
        suspendedPartner({ status: PartnerStatus.ACTIVE }),
      );
      await expect(
        service.submitAppeal({ partnerId: 'partner-1', body: 'x'.repeat(60) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException on missing partner', async () => {
      partnersRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.submitAppeal({ partnerId: 'missing', body: 'x'.repeat(60) }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ==========================================================================
  // resolveAppeal
  // ==========================================================================

  describe('resolveAppeal', () => {
    function stubUpdateBuilder() {
      const exec = jest.fn().mockResolvedValue({ affected: 0 });
      txCommissionsRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: exec,
      });
      return exec;
    }

    it('reinstates partner + resets fraud counter on decision=upheld', async () => {
      appealsRepo.findOne.mockResolvedValueOnce({
        id: 'appeal-1',
        partnerId: 'partner-1',
        appealNumber: 1,
        status: PartnerAppealStatus.OPEN,
      });
      partnersRepo.findOne.mockResolvedValueOnce(suspendedPartner());
      appealsRepo.count.mockResolvedValueOnce(0);
      const out = await service.resolveAppeal({
        appealId: 'appeal-1',
        adminUserId: 'admin-1',
        decision: 'upheld',
        resolutionNote: 'False positive',
      });
      expect(out.status).toBe(PartnerAppealStatus.UPHELD);
      // Partner row saved with ACTIVE + zeroed counter.
      const savedPartner = txPartnersRepo.save.mock.calls[0][0] as Partner;
      expect(savedPartner.status).toBe(PartnerStatus.ACTIVE);
      expect(savedPartner.fraudFlagCount).toBe(0);
      // Best-effort email fired.
      await new Promise((r) => setImmediate(r));
      expect(mail.send).toHaveBeenCalled();
    });

    it('denies without banning on the first denial', async () => {
      appealsRepo.findOne.mockResolvedValueOnce({
        id: 'appeal-1',
        partnerId: 'partner-1',
        appealNumber: 1,
        status: PartnerAppealStatus.OPEN,
      });
      partnersRepo.findOne.mockResolvedValueOnce(suspendedPartner());
      // Inside-tx count of denied appeals reflects the just-saved one → 1.
      txAppealsRepo.count.mockResolvedValueOnce(1);
      appealsRepo.count.mockResolvedValueOnce(1); // for the email path
      stubUpdateBuilder();
      const out = await service.resolveAppeal({
        appealId: 'appeal-1',
        adminUserId: 'admin-1',
        decision: 'denied',
      });
      expect(out.status).toBe(PartnerAppealStatus.DENIED);
      // Partner NOT banned yet.
      expect(txPartnersRepo.save).not.toHaveBeenCalled();
    });

    it('bans + forfeits outstanding commissions on the third denial', async () => {
      appealsRepo.findOne.mockResolvedValueOnce({
        id: 'appeal-3',
        partnerId: 'partner-1',
        appealNumber: 3,
        status: PartnerAppealStatus.OPEN,
      });
      partnersRepo.findOne.mockResolvedValueOnce(suspendedPartner());
      // Now three denials on record (including this one, saved in the txn).
      txAppealsRepo.count.mockResolvedValueOnce(3);
      appealsRepo.count.mockResolvedValueOnce(3);
      const exec = stubUpdateBuilder();
      const out = await service.resolveAppeal({
        appealId: 'appeal-3',
        adminUserId: 'admin-1',
        decision: 'denied',
      });
      expect(out.status).toBe(PartnerAppealStatus.DENIED);
      // Partner flipped to BANNED.
      const savedPartner = txPartnersRepo.save.mock.calls[0][0] as Partner;
      expect(savedPartner.status).toBe(PartnerStatus.BANNED);
      expect(savedPartner.bannedAt).toBeInstanceOf(Date);
      // Commissions forfeited.
      expect(exec).toHaveBeenCalled();
      // Ban email + appeal-resolved email both fired.
      await new Promise((r) => setImmediate(r));
      const events = mail.send.mock.calls.map((c) => c[0]);
      expect(events).toContain('partner_appeal_resolved');
      expect(events).toContain('partner_account_banned');
    });

    it('refuses to resolve a non-OPEN appeal', async () => {
      appealsRepo.findOne.mockResolvedValueOnce({
        id: 'appeal-1',
        status: PartnerAppealStatus.UPHELD,
      });
      await expect(
        service.resolveAppeal({
          appealId: 'appeal-1',
          adminUserId: 'a',
          decision: 'denied',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
