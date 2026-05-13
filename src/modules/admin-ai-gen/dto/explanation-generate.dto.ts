import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ExamType } from '../../../common/types/enums';

export class YearRangeDto {
  @ApiProperty({ minimum: 1990, maximum: 2100 })
  @IsInt()
  @Min(1990)
  @Max(2100)
  from!: number;

  @ApiProperty({ minimum: 1990, maximum: 2100 })
  @IsInt()
  @Min(1990)
  @Max(2100)
  to!: number;
}

export class ExplanationFiltersDto {
  @ApiPropertyOptional({ enum: ExamType })
  @IsOptional()
  @IsEnum(ExamType)
  examType?: ExamType;

  @ApiPropertyOptional({ isArray: true, type: String, format: 'uuid' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  subjectIds?: string[];

  @ApiPropertyOptional({ type: YearRangeDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => YearRangeDto)
  yearRange?: YearRangeDto;

  @ApiPropertyOptional({
    description: 'When false, only target questions without an explanation.',
  })
  @IsOptional()
  @IsBoolean()
  hasExplanation?: boolean;

  @ApiPropertyOptional({
    description: 'Explicit question ids — overrides all other filters.',
    isArray: true,
    type: String,
    format: 'uuid',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  questionIds?: string[];
}

export class ExplanationPreviewDto {
  @ApiProperty({ type: ExplanationFiltersDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ExplanationFiltersDto)
  filters!: ExplanationFiltersDto;

  @ApiProperty({ enum: ['claude-haiku', 'claude-sonnet'] })
  @IsEnum(['claude-haiku', 'claude-sonnet'] as const)
  model!: 'claude-haiku' | 'claude-sonnet';
}

export class ExplanationGenerateDto extends ExplanationPreviewDto {
  @ApiProperty({
    description:
      'Confirmation token returned by /admin/explanations/preview. Expires in 10 minutes.',
  })
  @IsString()
  confirmationToken!: string;
}
