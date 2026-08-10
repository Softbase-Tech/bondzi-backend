import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PartnerBannerAspect } from '../../../common/types/enums';

/**
 * Create payload for admin banner uploads. Every field except
 * label + imageUrl + aspect is optional — a minimal record is
 * label + URL + aspect.
 */
export class CreateBannerDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  label!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @ApiProperty()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(600)
  imageUrl!: string;

  @ApiProperty({ enum: PartnerBannerAspect })
  @IsEnum(PartnerBannerAspect)
  aspect!: PartnerBannerAspect;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  widthPx?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  heightPx?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** PATCH payload — same shape, everything optional. */
export class UpdateBannerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(600)
  imageUrl?: string;

  @ApiPropertyOptional({ enum: PartnerBannerAspect })
  @IsOptional()
  @IsEnum(PartnerBannerAspect)
  aspect?: PartnerBannerAspect;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  widthPx?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  heightPx?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
