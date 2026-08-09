import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Patch shape for `PATCH /admin/entitlements/:tier/:service`. All
 * three fields are independently optional so an admin can flip
 * `enabled` without accidentally resetting `dailyCap` or `config`.
 * `dailyCap` accepts `null` explicitly (uncap) — represented via a
 * separate `unlimitedCap` boolean because JSON `null` on the wire
 * doesn't survive class-validator's `@IsInt()` cleanly.
 */
export class UpdateTierServiceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /**
   * When set, `dailyCap` is stored as-is (must be ≥ 0). Ignored when
   * `unlimitedCap` is true.
   */
  @ApiPropertyOptional({
    description: 'Non-negative integer. Ignored when unlimitedCap = true.',
  })
  @ValidateIf((o: UpdateTierServiceDto) => o.unlimitedCap !== true)
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  dailyCap?: number;

  /** When true, `dailyCap` is written as SQL NULL (uncap). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  unlimitedCap?: boolean;

  @ApiPropertyOptional({ description: 'Free-form per-service config JSON.' })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
