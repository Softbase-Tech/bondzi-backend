import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  AccountType,
  ExamType,
  PromoDiscountType,
} from '../../../common/types/enums';

export class CreatePromoCodeDto {
  @ApiProperty({
    example: 'WELCOME20',
    minLength: 3,
    maxLength: 32,
    description:
      'Redemption code shown to the user. Case-insensitive at redeem time (stored lowercased).',
  })
  @IsString()
  @Length(3, 32)
  code!: string;

  @ApiPropertyOptional({
    description:
      'Internal note shown only in the admin list — not user-visible.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: PromoDiscountType })
  @IsEnum(PromoDiscountType)
  discountType!: PromoDiscountType;

  @ApiProperty({
    minimum: 0,
    description:
      'For `percent`: 0–100 (e.g. 20 = 20% off). For `fixed`: amount in the plan currency (e.g. 50 = 50 GHS off).',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10_000)
  discountValue!: number;

  @ApiPropertyOptional({
    enum: AccountType,
    description: 'Restrict to one account type (Plus or Pro). Null = any.',
  })
  @IsOptional()
  @IsEnum(AccountType)
  applicableAccount?: AccountType;

  @ApiPropertyOptional({
    enum: ExamType,
    description: 'Restrict to one level. Null = any.',
  })
  @IsOptional()
  @IsEnum(ExamType)
  applicableLevel?: ExamType;

  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Cap the total number of redemptions across all users. Null = unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number;

  @ApiPropertyOptional({
    description: 'ISO timestamp; null = active immediately.',
  })
  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @ApiPropertyOptional({ description: 'ISO timestamp; null = never expires.' })
  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePromoCodeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10_000)
  discountValue?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
