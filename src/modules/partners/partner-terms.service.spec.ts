import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { PartnerTermsVersion } from './entities/partner-terms-version.entity';
import { Partner } from './entities/partner.entity';
import { PartnerTermsService } from './partner-terms.service';

describe('PartnerTermsService', () => {
  let service: PartnerTermsService;
  let repo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
  };

  const chain = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };

  beforeEach(async () => {
    chain.getOne.mockReset();
    chain.where.mockClear();
    chain.orderBy.mockClear();
    chain.addOrderBy.mockClear();
    repo = {
      createQueryBuilder: jest.fn().mockReturnValue(chain),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        PartnerTermsService,
        { provide: getRepositoryToken(PartnerTermsVersion), useValue: repo },
        {
          provide: getRepositoryToken(Partner),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: MailService,
          useValue: {
            send: jest.fn().mockResolvedValue(undefined),
            getWebUrl: jest.fn().mockReturnValue('https://bondzi.app'),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(PartnerTermsService);
  });

  it('returns the most recent version whose effective_from is in the past', async () => {
    const row = { id: 't1', version: 2 } as PartnerTermsVersion;
    chain.getOne.mockResolvedValueOnce(row);
    const result = await service.getCurrent();
    expect(result).toBe(row);
    expect(chain.where).toHaveBeenCalledWith(
      't.effective_from <= :now',
      expect.any(Object),
    );
  });

  it('falls back to the newest version if none are yet effective', async () => {
    const fallback = { id: 't-fallback', version: 5 } as PartnerTermsVersion;
    // First query (active) returns null → fallback branch fires.
    chain.getOne.mockResolvedValueOnce(null);
    chain.getOne.mockResolvedValueOnce(fallback);
    const result = await service.getCurrent();
    expect(result).toBe(fallback);
  });

  it('throws NotFoundException when zero terms rows exist (broken seed)', async () => {
    chain.getOne.mockResolvedValueOnce(null);
    chain.getOne.mockResolvedValueOnce(null);
    await expect(service.getCurrent()).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('createNewVersion', () => {
    let saveMock: jest.Mock;
    let createMock: jest.Mock;
    let partnersFind: jest.Mock;
    let mailSend: jest.Mock;

    beforeEach(async () => {
      // Rebuild service with a richer mock so the create path exercises.
      saveMock = jest.fn(async (o) => ({ id: 'new-terms', ...o }));
      createMock = jest.fn((o) => o);
      partnersFind = jest.fn().mockResolvedValue([
        {
          id: 'p1',
          userId: 'u1',
          email: 'a@x.com',
          fullName: 'Alice',
        },
        {
          id: 'p2',
          userId: 'u2',
          email: 'b@x.com',
          fullName: 'Bob',
        },
      ]);
      mailSend = jest.fn().mockResolvedValue(undefined);
      const versionChain = {
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ max: 4 }),
      };
      const richRepo = {
        createQueryBuilder: jest.fn().mockReturnValue(versionChain),
        save: saveMock,
        create: createMock,
        findOne: jest.fn(),
        find: jest.fn(),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          PartnerTermsService,
          {
            provide: getRepositoryToken(PartnerTermsVersion),
            useValue: richRepo,
          },
          {
            provide: getRepositoryToken(Partner),
            useValue: { find: partnersFind },
          },
          {
            provide: MailService,
            useValue: {
              send: mailSend,
              getWebUrl: jest.fn().mockReturnValue('https://bondzi.app/'),
            },
          },
        ],
      }).compile();
      service = moduleRef.get(PartnerTermsService);
    });

    it('inserts the next version, snapshots createdBy, broadcasts to active partners', async () => {
      const out = await service.createNewVersion({
        createdBy: 'admin-1',
        title: 'Terms v5',
        bodyMd: 'Full markdown body long enough to pass validation.',
        changeSummary: 'Bumped WASSCE Plus payout to 35.',
        plusWassce: '35.00',
        plusNovdec: '30.00',
        plusBece: '15.00',
      });
      expect(out.version).toBe(5);
      expect(createMock.mock.calls[0][0].createdBy).toBe('admin-1');
      // Broadcast fired for both partners.
      await new Promise((r) => setImmediate(r));
      expect(mailSend).toHaveBeenCalledTimes(2);
      const events = new Set(mailSend.mock.calls.map((c) => c[0]));
      expect(events).toEqual(new Set(['partner_terms_updated']));
      const payload = mailSend.mock.calls[0][2];
      expect(payload.newVersion).toBe(5);
      expect(payload.changeSummary).toBe('Bumped WASSCE Plus payout to 35.');
    });

    it('starts at version 1 when there are no existing rows', async () => {
      // Re-stub the version query to return null.
      const moduleRef = await Test.createTestingModule({
        providers: [
          PartnerTermsService,
          {
            provide: getRepositoryToken(PartnerTermsVersion),
            useValue: {
              createQueryBuilder: jest.fn().mockReturnValue({
                select: jest.fn().mockReturnThis(),
                getRawOne: jest.fn().mockResolvedValue({ max: null }),
              }),
              save: saveMock,
              create: createMock,
              findOne: jest.fn(),
              find: jest.fn(),
            },
          },
          {
            provide: getRepositoryToken(Partner),
            useValue: { find: jest.fn().mockResolvedValue([]) },
          },
          {
            provide: MailService,
            useValue: {
              send: mailSend,
              getWebUrl: jest.fn().mockReturnValue('https://bondzi.app'),
            },
          },
        ],
      }).compile();
      const svc = moduleRef.get(PartnerTermsService);
      const out = await svc.createNewVersion({
        createdBy: 'admin-1',
        title: 'First terms',
        bodyMd: 'Full markdown body long enough to pass validation.',
        changeSummary: 'Initial terms.',
        plusWassce: '30.00',
        plusNovdec: '30.00',
        plusBece: '15.00',
      });
      expect(out.version).toBe(1);
    });
  });
});
