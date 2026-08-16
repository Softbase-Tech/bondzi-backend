import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FaqService } from './faq.service';
import { FaqEntry } from './entities/faq-entry.entity';

/**
 * FaqService guarantees:
 *   1. `getBySlug` returns retired entries too (so live share links
 *      degrade cleanly to a "retired" state instead of a 404).
 *   2. `create` rejects duplicate slugs at the app layer with a 400
 *      before Postgres' unique-violation would bubble as a 500.
 *   3. `retire` is a soft-delete — it flips `is_active=false`,
 *      never a hard delete, so per-slug deep links stay reachable.
 */
describe('FaqService', () => {
  let service: FaqService;
  let repo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        FaqService,
        { provide: getRepositoryToken(FaqEntry), useValue: repo },
      ],
    }).compile();
    service = moduleRef.get(FaqService);
  });

  describe('getBySlug', () => {
    it('returns the entry when found (active or retired)', async () => {
      const retired = { id: 'a', slug: 'foo', isActive: false } as FaqEntry;
      repo.findOne.mockResolvedValue(retired);
      const result = await service.getBySlug('foo');
      expect(result).toBe(retired);
      expect(repo.findOne).toHaveBeenCalledWith({ where: { slug: 'foo' } });
    });

    it('throws NotFound when the slug is unknown', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getBySlug('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('rejects a duplicate slug with a 400 before hitting the DB constraint', async () => {
      repo.findOne.mockResolvedValue({ id: 'existing', slug: 'dupe' });
      await expect(
        service.create({
          slug: 'dupe',
          question: 'Q?',
          answerMarkdown: 'A.',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('creates when the slug is unused', async () => {
      repo.findOne.mockResolvedValue(null);
      const saved = { id: 'new', slug: 'fresh' } as FaqEntry;
      repo.create.mockReturnValue(saved);
      repo.save.mockResolvedValue(saved);
      const result = await service.create({
        slug: 'fresh',
        question: 'Question?',
        answerMarkdown: 'Answer body here.',
      });
      expect(result).toBe(saved);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'fresh',
          question: 'Question?',
          answerMarkdown: 'Answer body here.',
          isActive: true,
          sortOrder: 0,
        }),
      );
    });
  });

  describe('retire', () => {
    it('soft-deletes by flipping is_active=false', async () => {
      const entry = { id: 'z', slug: 's', isActive: true } as FaqEntry;
      repo.findOne.mockResolvedValue(entry);
      repo.save.mockImplementation(async (e) => e);
      const result = await service.retire('z');
      expect(result.isActive).toBe(false);
      // Sanity: no hard-delete path was taken.
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'z', isActive: false }),
      );
    });

    it('404s when the id is unknown', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.retire('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('listPublished', () => {
    it('filters is_active=true and orders by sort_order then created_at', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      repo.createQueryBuilder.mockReturnValue(qb);
      await service.listPublished();
      expect(qb.where).toHaveBeenCalledWith('f.is_active = true');
      expect(qb.orderBy).toHaveBeenCalledWith('f.sort_order', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('f.created_at', 'ASC');
    });
  });
});
