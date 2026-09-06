import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class WebAdPlacementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'AdSense ad-unit (slot) id' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[0-9]*$/, { message: 'slotId is the numeric AdSense unit id' })
  slotId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 40 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(40)
  afterBlock?: number;
}

export class WebAdsConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'ca-pub-…' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^ca-pub-\d+$/, { message: 'publisherId must look like ca-pub-…' })
  publisherId?: string;

  // Free-form placement map — keys are placement names (blog_inline,
  // blog_footer, landing_mid, app_dashboard, …). Values validated by
  // the service so a typo'd key can't crash the website reader.
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  placements?: Record<string, WebAdPlacementDto>;
}

export class UpdateAdConfigDto {
  @ApiPropertyOptional({ type: WebAdsConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WebAdsConfigDto)
  webAds?: WebAdsConfigDto;

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
