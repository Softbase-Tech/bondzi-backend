import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MomoProvider, PartnerStatus } from '../../common/types/enums';
import { User } from '../users/entities/user.entity';
import { PartnerReferralCode } from './entities/partner-referral-code.entity';
import { Partner } from './entities/partner.entity';
import { PartnerTermsService } from './partner-terms.service';
import { PartnersService } from './partners.service';

describe('PartnersService', () => {
  let service: PartnersService;
  let partnersRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let codesRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let usersRepo: {
    findOne: jest.Mock;
  };
  let terms: { getCurrent: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  const activePartner = (patch: Partial<Partner> = {}) =>
    ({
      id: 'p1',
      userId: 'user-1',
      email: 'k@example.com',
      phone: '+233209000000',
      fullName: 'Kwame',
      countryCode: 'GH',
      momoProvider: MomoProvider.MTN,
      momoNumber: '0209000000',
      momoAccountName: 'Kwame Partner',
      status: PartnerStatus.ACTIVE,
      agreedTermsVersionId: 't1',
      fraudFlagCount: 0,
      ...patch,
    }) as unknown as Partner;

  const userRow = {
    id: 'user-1',
    fullName: 'Kwame Test',
    referralCode: 'STUDENT7',
    isActive: true,
  } as unknown as User;

  beforeEach(async () => {
    partnersRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (o) => ({ id: 'p-generated', ...o })),
      create: jest.fn((o) => o),
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      }),
    };
    codesRepo = {
      find: jest.fn().mockResolvedValue([]),
      // Default: no code collision. The register/createCode allocator
      // loops until this returns null.
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(async (o) => ({ id: 'code-1', ...o })),
      create: jest.fn((o) => o),
    };
    usersRepo = {
      // First call inside register() is `findOne({ where: { id } })`
      // to look up the calling user. Later calls inside
      // allocateUniqueCode do `findOne({ where: { referralCode } })`
      // to check the STUDENT namespace for collisions — those must
      // return null so the partner-code allocator picks a fresh code.
      findOne: jest.fn().mockImplementation(async (opts: any) => {
        const where = opts?.where ?? {};
        if ('id' in where) return userRow;
        if ('referralCode' in where) return null;
        return null;
      }),
    };
    terms = {
      getCurrent: jest.fn().mockResolvedValue({ id: 'terms-1' }),
    };

    // Identity-based dispatch is more reliable than name-string
    // matching — TypeORM's entity classes are passed by reference.
    type MockEm = { getRepository: jest.Mock };
    const em: MockEm = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Partner) return partnersRepo;
        if (entity === PartnerReferralCode) return codesRepo;
        if (entity === User) return usersRepo;
        throw new Error(
          `unexpected em.getRepository call in test: ${(entity as { name?: string })?.name ?? String(entity)}`,
        );
      }),
    };
    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(async (fn: (em: MockEm) => Promise<unknown>) =>
          fn(em),
        ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PartnersService,
        { provide: getRepositoryToken(Partner), useValue: partnersRepo },
        {
          provide: getRepositoryToken(PartnerReferralCode),
          useValue: codesRepo,
        },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: PartnerTermsService, useValue: terms },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(PartnersService);
  });

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  it('register creates partner + default code, snapshotting current terms version', async () => {
    const out = await service.register('user-1', {
      email: 'k@example.com',
      phone: '+233209000000',
      fullName: 'Kwame',
      momoProvider: MomoProvider.MTN,
      momoNumber: '0209000000',
      momoAccountName: 'Kwame Partner',
    });
    expect(out.agreedTermsVersionId).toBe('terms-1');
    expect(out.status).toBe(PartnerStatus.PENDING);
    // Default code was saved.
    expect(codesRepo.save).toHaveBeenCalled();
    const codeRow = codesRepo.save.mock.calls[0][0];
    expect(codeRow.isDefault).toBe(true);
    expect(codeRow.isActive).toBe(true);
    expect(codeRow.code).toMatch(/^[A-Z0-9]{7}$/);
  });

  it('register refuses when the user already has a partner row', async () => {
    partnersRepo.findOne.mockResolvedValueOnce(activePartner());
    await expect(
      service.register('user-1', {
        email: 'k@example.com',
        phone: '+233209000000',
        fullName: 'Kwame',
        momoProvider: MomoProvider.MTN,
        momoNumber: '0209000000',
        momoAccountName: 'Kwame Partner',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('register refuses on missing user', async () => {
    usersRepo.findOne.mockResolvedValueOnce(null);
    await expect(
      service.register('missing', {
        email: 'x@example.com',
        phone: '+233209111111',
        fullName: 'Nobody',
        momoProvider: MomoProvider.MTN,
        momoNumber: '0209111111',
        momoAccountName: 'Nobody',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('register refuses on email collision with existing partner', async () => {
    partnersRepo.createQueryBuilder.mockReturnValueOnce({
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(activePartner()),
    });
    await expect(
      service.register('user-1', {
        email: 'other@example.com',
        phone: '+233209111111',
        fullName: 'Kwame',
        momoProvider: MomoProvider.MTN,
        momoNumber: '0209111111',
        momoAccountName: 'Kwame Partner',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // -------------------------------------------------------------------------
  // codes
  // -------------------------------------------------------------------------

  it('createCode allocates a unique 7-char code and saves it as non-default', async () => {
    partnersRepo.findOne.mockResolvedValueOnce(activePartner());
    const out = await service.createCode('user-1', { label: 'Instagram Feb' });
    expect(out).toBeDefined();
    const row = codesRepo.save.mock.calls[0][0];
    expect(row.isDefault).toBe(false);
    expect(row.isActive).toBe(true);
    expect(row.label).toBe('Instagram Feb');
    expect(row.code).toMatch(/^[A-Z0-9]{7}$/);
  });

  it('createCode refuses for banned partners', async () => {
    partnersRepo.findOne.mockResolvedValueOnce(
      activePartner({ status: PartnerStatus.BANNED }),
    );
    await expect(
      service.createCode('user-1', { label: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('setCodeActive refuses to deactivate the default code', async () => {
    partnersRepo.findOne.mockResolvedValueOnce(activePartner());
    codesRepo.findOne.mockResolvedValueOnce({
      id: 'default-code',
      partnerId: 'p1',
      isDefault: true,
    });
    await expect(
      service.setCodeActive('user-1', 'default-code', false),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('setCodeActive toggles a non-default code', async () => {
    partnersRepo.findOne.mockResolvedValueOnce(activePartner());
    codesRepo.findOne.mockResolvedValueOnce({
      id: 'code-2',
      partnerId: 'p1',
      isDefault: false,
      isActive: true,
    });
    const out = await service.setCodeActive('user-1', 'code-2', false);
    expect(out.isActive).toBe(false);
    expect(codesRepo.save).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // findActiveCode
  // -------------------------------------------------------------------------

  it('findActiveCode uppercases and trims before lookup', async () => {
    codesRepo.findOne.mockResolvedValueOnce({ id: 'code-1' });
    const out = await service.findActiveCode('  a1b2cjo  ');
    expect(codesRepo.findOne).toHaveBeenCalledWith({
      where: { code: 'A1B2CJO', isActive: true },
    });
    expect(out).toBeTruthy();
  });

  it('findActiveCode returns null for empty input', async () => {
    const out = await service.findActiveCode('   ');
    expect(out).toBeNull();
    expect(codesRepo.findOne).not.toHaveBeenCalled();
  });
});
