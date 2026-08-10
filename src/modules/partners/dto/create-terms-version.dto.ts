import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Admin creates a new immutable terms version. Every field is
 * required — versioning is only useful when the full rate card + the
 * change summary snapshot together, so we don't allow partials.
 */
export class CreateTermsVersionDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ description: 'Full terms body in markdown.' })
  @IsString()
  @MinLength(20)
  bodyMd!: string;

  @ApiProperty({
    description:
      'One-paragraph summary of what changed — carried into the broadcast email.',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(600)
  changeSummary!: string;

  @ApiProperty({ description: 'GHC amount per WASSCE Plus purchase.' })
  @IsNumberString()
  plusWassce!: string;

  @ApiProperty()
  @IsNumberString()
  plusNovdec!: string;

  @ApiProperty()
  @IsNumberString()
  plusBece!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  signupBatchSize?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  signupBatchAmountGhs?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  signupMinCompletedAnswers?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  answersBonusThreshold?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  answersBonusAmountGhs?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  attributionWindowDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxFraudFlagsBeforeBlock?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxAppeals?: number;

  @ApiPropertyOptional({
    description:
      'When the new terms take effect. Defaults to now — pass a future ISO date to stage.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  effectiveFrom?: Date;
}
