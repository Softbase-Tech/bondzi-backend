import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerBannerAspect } from '../../common/types/enums';
import { PartnerBanner } from './entities/partner-banner.entity';

/**
 * Banner gallery CRUD.
 *
 * Read paths:
 *   - listActive  — used by the partner portal; skips deactivated
 *                   rows, orders by sort_order ASC then createdAt DESC.
 *   - listAll     — admin view; every row regardless of active state.
 *
 * Write paths (admin-only, controller-gated):
 *   - create     — insert a new banner. Validates that the URL looks
 *                  like an HTTPS asset URL and that width/height, if
 *                  provided, are positive.
 *   - update     — patch any subset of fields. Same validation.
 *   - remove     — hard-delete. Rare; admin uses `update({isActive:false})`
 *                  for the more common "retire" case.
 */
@Injectable()
export class PartnerBannersService {
  constructor(
    @InjectRepository(PartnerBanner)
    private readonly bannersRepo: Repository<PartnerBanner>,
  ) {}

  async listActive(): Promise<PartnerBanner[]> {
    return this.bannersRepo.find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', createdAt: 'DESC' },
    });
  }

  async listAll(): Promise<PartnerBanner[]> {
    return this.bannersRepo.find({
      order: { sortOrder: 'ASC', createdAt: 'DESC' },
    });
  }

  async findById(id: string): Promise<PartnerBanner> {
    const row = await this.bannersRepo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Banner not found.');
    return row;
  }

  async create(input: {
    createdBy: string;
    label: string;
    description?: string | null;
    imageUrl: string;
    aspect?: PartnerBannerAspect;
    widthPx?: number | null;
    heightPx?: number | null;
    sortOrder?: number;
    isActive?: boolean;
  }): Promise<PartnerBanner> {
    this.validateUrl(input.imageUrl);
    this.validateDimensions(input.widthPx, input.heightPx);
    return this.bannersRepo.save(
      this.bannersRepo.create({
        createdBy: input.createdBy,
        label: input.label.trim(),
        description: input.description?.trim() ?? null,
        imageUrl: input.imageUrl.trim(),
        aspect: input.aspect ?? PartnerBannerAspect.SQUARE,
        widthPx: input.widthPx ?? null,
        heightPx: input.heightPx ?? null,
        sortOrder: input.sortOrder ?? 100,
        isActive: input.isActive ?? true,
      }),
    );
  }

  async update(
    id: string,
    patch: {
      label?: string;
      description?: string | null;
      imageUrl?: string;
      aspect?: PartnerBannerAspect;
      widthPx?: number | null;
      heightPx?: number | null;
      sortOrder?: number;
      isActive?: boolean;
    },
  ): Promise<PartnerBanner> {
    const row = await this.findById(id);
    if (patch.imageUrl !== undefined) {
      this.validateUrl(patch.imageUrl);
      row.imageUrl = patch.imageUrl.trim();
    }
    if (patch.widthPx !== undefined || patch.heightPx !== undefined) {
      this.validateDimensions(
        patch.widthPx ?? row.widthPx,
        patch.heightPx ?? row.heightPx,
      );
    }
    if (patch.label !== undefined) row.label = patch.label.trim();
    if (patch.description !== undefined)
      row.description = patch.description?.trim() ?? null;
    if (patch.aspect !== undefined) row.aspect = patch.aspect;
    if (patch.widthPx !== undefined) row.widthPx = patch.widthPx;
    if (patch.heightPx !== undefined) row.heightPx = patch.heightPx;
    if (patch.sortOrder !== undefined) row.sortOrder = patch.sortOrder;
    if (patch.isActive !== undefined) row.isActive = patch.isActive;
    return this.bannersRepo.save(row);
  }

  async remove(id: string): Promise<void> {
    const row = await this.findById(id);
    await this.bannersRepo.remove(row);
  }

  // ------------------------------------------------------------------
  // Guards
  // ------------------------------------------------------------------

  private validateUrl(url: string): void {
    const trimmed = url.trim();
    if (!/^https:\/\//i.test(trimmed)) {
      throw new BadRequestException(
        'Banner image_url must be an https:// URL.',
      );
    }
    try {
      // Full URL parse — catches spaces, malformed hosts, etc.

      new URL(trimmed);
    } catch {
      throw new BadRequestException('Banner image_url is not a valid URL.');
    }
  }

  private validateDimensions(
    width: number | null | undefined,
    height: number | null | undefined,
  ): void {
    if (width != null && width <= 0) {
      throw new BadRequestException('width_px must be a positive integer.');
    }
    if (height != null && height <= 0) {
      throw new BadRequestException('height_px must be a positive integer.');
    }
  }
}
