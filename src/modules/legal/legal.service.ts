import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LegalPage } from './entities/legal-page.entity';

/**
 * Storage + retrieval for admin-editable static legal documents:
 * refund-policy, terms, privacy. The list is open-ended — admins create
 * new pages by inserting a new slug.
 */
@Injectable()
export class LegalService {
  constructor(
    @InjectRepository(LegalPage)
    private readonly repo: Repository<LegalPage>,
  ) {}

  list(): Promise<LegalPage[]> {
    return this.repo.find({ order: { slug: 'ASC' } });
  }

  /**
   * Public read-by-slug. Used by the mobile app's refund-policy /
   * terms / privacy screens.
   */
  async getBySlug(slug: string): Promise<LegalPage> {
    const row = await this.repo.findOne({ where: { slug } });
    if (!row) {
      throw new NotFoundException(`No legal page found for slug '${slug}'.`);
    }
    return row;
  }

  /**
   * Admin upsert by slug. If the slug doesn't exist, insert it; otherwise
   * update title + body. We use slug-not-id as the natural key because
   * admin URLs reference slugs ("edit /admin/legal/refund-policy") and
   * the upsert behaviour means a fresh deployment can ensure required
   * pages exist via the seed without race conditions.
   */
  async upsert(args: {
    slug: string;
    title: string;
    body: string;
    updatedBy: string;
  }): Promise<LegalPage> {
    const existing = await this.repo.findOne({ where: { slug: args.slug } });
    if (existing) {
      existing.title = args.title;
      existing.body = args.body;
      existing.updatedBy = args.updatedBy;
      return this.repo.save(existing);
    }
    const row = this.repo.create({
      slug: args.slug,
      title: args.title,
      body: args.body,
      updatedBy: args.updatedBy,
    });
    return this.repo.save(row);
  }

  async delete(slug: string): Promise<void> {
    const res = await this.repo.delete({ slug });
    if (res.affected === 0) {
      throw new NotFoundException(`No legal page found for slug '${slug}'.`);
    }
  }
}
