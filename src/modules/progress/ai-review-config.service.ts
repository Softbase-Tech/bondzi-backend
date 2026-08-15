import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiReviewConfig } from './entities/ai-review-config.entity';
import { UpdateAiReviewConfigDto } from './dto/update-ai-review-config.dto';

/**
 * Read/write the single-row AI-review limits config. Mirrors
 * AdsService.getAdminConfig — auto-provisions a row if the seed was
 * somehow skipped so the admin form never renders empty.
 */
@Injectable()
export class AiReviewConfigService {
  constructor(
    @InjectRepository(AiReviewConfig)
    private readonly configRepo: Repository<AiReviewConfig>,
  ) {}

  async get(): Promise<AiReviewConfig> {
    let row = await this.configRepo
      .createQueryBuilder('c')
      .orderBy('c.updatedAt', 'DESC')
      .getOne();
    if (!row) {
      row = this.configRepo.create({});
      await this.configRepo.save(row);
    }
    return row;
  }

  async update(patch: UpdateAiReviewConfigDto): Promise<AiReviewConfig> {
    const row = await this.get();
    Object.assign(row, patch);
    return this.configRepo.save(row);
  }
}
