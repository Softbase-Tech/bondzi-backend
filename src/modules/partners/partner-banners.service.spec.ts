import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PartnerBannerAspect } from '../../common/types/enums';
import { PartnerBanner } from './entities/partner-banner.entity';
import { PartnerBannersService } from './partner-banners.service';

describe('PartnerBannersService', () => {
  let service: PartnerBannersService;
  let repo: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn(async (o) => ({ id: 'banner-1', ...o })),
      create: jest.fn((o) => o),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        PartnerBannersService,
        { provide: getRepositoryToken(PartnerBanner), useValue: repo },
      ],
    }).compile();
    service = moduleRef.get(PartnerBannersService);
  });

  // ==========================================================================
  // Reads
  // ==========================================================================

  it('listActive filters to isActive=true', async () => {
    await service.listActive();
    expect(repo.find).toHaveBeenCalledWith({
      where: { isActive: true },
      order: { sortOrder: 'ASC', createdAt: 'DESC' },
    });
  });

  it('listAll returns everything, sorted', async () => {
    await service.listAll();
    expect(repo.find).toHaveBeenCalledWith({
      order: { sortOrder: 'ASC', createdAt: 'DESC' },
    });
  });

  it('findById throws NotFoundException when missing', async () => {
    repo.findOne.mockResolvedValueOnce(null);
    await expect(service.findById('x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ==========================================================================
  // create
  // ==========================================================================

  describe('create', () => {
    it('inserts a row and defaults optional fields', async () => {
      const out = await service.create({
        createdBy: 'admin-1',
        label: '  Instagram tile  ',
        imageUrl: 'https://cdn.example.com/tile.png',
        aspect: PartnerBannerAspect.SQUARE,
      });
      expect(out).toBeDefined();
      const saved = repo.save.mock.calls[0][0];
      expect(saved.label).toBe('Instagram tile');
      expect(saved.imageUrl).toBe('https://cdn.example.com/tile.png');
      expect(saved.aspect).toBe(PartnerBannerAspect.SQUARE);
      expect(saved.sortOrder).toBe(100);
      expect(saved.isActive).toBe(true);
      expect(saved.createdBy).toBe('admin-1');
    });

    it('rejects non-https URLs', async () => {
      await expect(
        service.create({
          createdBy: 'admin-1',
          label: 'x',
          imageUrl: 'http://insecure.example.com/x.png',
          aspect: PartnerBannerAspect.SQUARE,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects zero/negative dimensions', async () => {
      await expect(
        service.create({
          createdBy: 'admin-1',
          label: 'x',
          imageUrl: 'https://cdn.example.com/x.png',
          aspect: PartnerBannerAspect.SQUARE,
          widthPx: 0,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects malformed URLs', async () => {
      await expect(
        service.create({
          createdBy: 'admin-1',
          label: 'x',
          imageUrl: 'https://has spaces',
          aspect: PartnerBannerAspect.SQUARE,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ==========================================================================
  // update
  // ==========================================================================

  describe('update', () => {
    it('patches provided fields only', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 'b1',
        label: 'Old',
        description: 'Old desc',
        imageUrl: 'https://cdn.example.com/a.png',
        aspect: PartnerBannerAspect.SQUARE,
        widthPx: 500,
        heightPx: 500,
        sortOrder: 100,
        isActive: true,
      });
      const out = await service.update('b1', {
        label: '  New  ',
        isActive: false,
      });
      expect(out.label).toBe('New');
      expect(out.isActive).toBe(false);
      // Unchanged fields preserved.
      expect(out.imageUrl).toBe('https://cdn.example.com/a.png');
    });

    it('re-validates the URL when imageUrl changes', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 'b1',
        imageUrl: 'https://cdn.example.com/a.png',
        widthPx: 500,
        heightPx: 500,
      });
      await expect(
        service.update('b1', { imageUrl: 'ftp://bad' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ==========================================================================
  // remove
  // ==========================================================================

  it('remove deletes the row', async () => {
    repo.findOne.mockResolvedValueOnce({ id: 'b1' });
    await service.remove('b1');
    expect(repo.remove).toHaveBeenCalled();
  });
});
