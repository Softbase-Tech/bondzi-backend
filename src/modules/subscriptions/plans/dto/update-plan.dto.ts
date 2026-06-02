import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/**
 * PATCH /admin/plans/:id body. Any combination of fields may be supplied.
 *
 * Cosmetic fields (name, description, isActive, isDefault) update the row
 * in place. Any price or duration change triggers a version bump: a new
 * plan row is inserted, the previous row is flipped to is_active=false, and
 * the provider is called for each cadence whose price changed.
 *
 * country_code / currency / provider are intentionally missing — changing
 * any of those is a different product and must go through POST /admin/plans.
 */
export class UpdatePlanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  monthlyPrice?: number;

  @ApiPropertyOptional({
    description:
      'Recurring plans only. Defaults to 0 on one-time plans, where it must not be set.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  sixMonthPrice?: number;

  @ApiPropertyOptional({
    description:
      'Recurring plans only. Defaults to 0 on one-time plans, where it must not be set.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  annualPrice?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100,
    description:
      'VAT rate baked into the displayed price (inclusive). Setting from 0 → non-zero (or back) is safe — it only changes how the receipt PDF breaks the price down.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  vatRatePct?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  monthlyDurationDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  sixMonthDurationDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  annualDurationDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
