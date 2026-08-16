import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FaqEntry } from './entities/faq-entry.entity';
import { CreateFaqDto, UpsertFaqDto } from './dto/upsert-faq.dto';

@Injectable()
export class FaqService {
  constructor(
    @InjectRepository(FaqEntry)
    private readonly repo: Repository<FaqEntry>,
  ) {}

  /**
   * Public-facing list — only published (`is_active=true`) rows, in
   * sort order, ties broken by createdAt so the mobile client sees a
   * stable order across reads.
   */
  async listPublished(): Promise<FaqEntry[]> {
    return this.repo
      .createQueryBuilder('f')
      .where('f.is_active = true')
      .orderBy('f.sort_order', 'ASC')
      .addOrderBy('f.created_at', 'ASC')
      .getMany();
  }

  /**
   * Detail by slug. Returns retired entries too so a live deep link
   * from an old share lands on a real page (the mobile client
   * degrades the display when `isActive=false`), rather than a 404
   * that reads as broken.
   */
  async getBySlug(slug: string): Promise<FaqEntry> {
    const entry = await this.repo.findOne({ where: { slug } });
    if (!entry) throw new NotFoundException(`No FAQ entry for slug "${slug}".`);
    return entry;
  }

  /** Admin listing — every row, active + retired, in sort order. */
  async listAllForAdmin(): Promise<FaqEntry[]> {
    return this.repo
      .createQueryBuilder('f')
      .orderBy('f.is_active', 'DESC')
      .addOrderBy('f.sort_order', 'ASC')
      .addOrderBy('f.created_at', 'ASC')
      .getMany();
  }

  async create(dto: CreateFaqDto): Promise<FaqEntry> {
    // Uniqueness pre-check gives a clean 400 instead of a Postgres
    // unique-violation exception bubbling as 500. The DB constraint
    // remains the source of truth.
    const clash = await this.repo.findOne({ where: { slug: dto.slug } });
    if (clash) {
      throw new BadRequestException(
        `An FAQ entry with slug "${dto.slug}" already exists.`,
      );
    }
    const entry = this.repo.create({
      slug: dto.slug,
      question: dto.question,
      answerMarkdown: dto.answerMarkdown,
      sortOrder: dto.sortOrder ?? 0,
      isActive: dto.isActive ?? true,
    });
    return this.repo.save(entry);
  }

  async update(id: string, dto: UpsertFaqDto): Promise<FaqEntry> {
    const entry = await this.repo.findOne({ where: { id } });
    if (!entry) throw new NotFoundException(`No FAQ entry for id "${id}".`);
    if (dto.slug && dto.slug !== entry.slug) {
      const clash = await this.repo.findOne({ where: { slug: dto.slug } });
      if (clash && clash.id !== id) {
        throw new BadRequestException(
          `An FAQ entry with slug "${dto.slug}" already exists.`,
        );
      }
      entry.slug = dto.slug;
    }
    if (dto.question !== undefined) entry.question = dto.question;
    if (dto.answerMarkdown !== undefined) {
      entry.answerMarkdown = dto.answerMarkdown;
    }
    if (dto.sortOrder !== undefined) entry.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) entry.isActive = dto.isActive;
    return this.repo.save(entry);
  }

  /**
   * Retire (soft-delete) — flips is_active=false. We never hard-
   * delete a row so a live deep link from a share doesn't 404.
   */
  async retire(id: string): Promise<FaqEntry> {
    const entry = await this.repo.findOne({ where: { id } });
    if (!entry) throw new NotFoundException(`No FAQ entry for id "${id}".`);
    entry.isActive = false;
    return this.repo.save(entry);
  }
}
