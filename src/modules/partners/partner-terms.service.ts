import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerTermsVersion } from './entities/partner-terms-version.entity';

/**
 * Reads the versioned commission-terms document. Writes (creating a
 * new version, sending the "terms updated" email) live in
 * Phase 5 — for Phase 1 we only need to read the current version so
 * that partner registration can stamp `agreed_terms_version_id` and
 * commissions can stamp `terms_version_id` at earn time.
 */
@Injectable()
export class PartnerTermsService {
  constructor(
    @InjectRepository(PartnerTermsVersion)
    private readonly termsRepo: Repository<PartnerTermsVersion>,
  ) {}

  /**
   * Latest terms version whose `effective_from` is in the past.
   * Falls back to the most recent row if none are yet active (should
   * only happen in a broken seed).
   */
  async getCurrent(): Promise<PartnerTermsVersion> {
    const now = new Date();
    const active = await this.termsRepo
      .createQueryBuilder('t')
      .where('t.effective_from <= :now', { now })
      .orderBy('t.effective_from', 'DESC')
      .addOrderBy('t.version', 'DESC')
      .getOne();
    if (active) return active;

    const fallback = await this.termsRepo
      .createQueryBuilder('t')
      .orderBy('t.version', 'DESC')
      .getOne();
    if (!fallback) {
      throw new NotFoundException(
        'No partner terms versions have been seeded.',
      );
    }
    return fallback;
  }

  async findById(id: string): Promise<PartnerTermsVersion> {
    const row = await this.termsRepo.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Terms version not found.');
    }
    return row;
  }

  async listAll(): Promise<PartnerTermsVersion[]> {
    return this.termsRepo.find({ order: { version: 'DESC' } });
  }
}
