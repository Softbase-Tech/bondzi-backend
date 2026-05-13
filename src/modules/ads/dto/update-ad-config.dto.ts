import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateAdConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  adsEnabled?: boolean;

  @ApiPropertyOptional({ enum: ['admob', 'adsense'] })
  @IsOptional()
  @IsIn(['admob', 'adsense'] as const)
  adNetwork?: 'admob' | 'adsense';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  admobAppId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  admobInterstitialId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  admobRewardedId?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  rewardedXpAmount?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  frequencyCap?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  triggerEvent?: string;
}
