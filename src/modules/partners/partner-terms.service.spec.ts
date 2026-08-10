import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { PartnerTermsVersion } from './entities/partner-terms-version.entity';
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
});
