import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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

export class DifficultyMixDto {
  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  easy!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  medium!: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  hard!: number;
}

export class PmTestSelectionDto {
  @ApiProperty({ enum: [1, 2, 3] })
  @IsInt()
  @Min(1)
  @Max(3)
  formLevel!: number;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  subjectId!: string;

  @ApiPropertyOptional({ isArray: true, type: String, format: 'uuid' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  syllabusTopicIds?: string[];

  @ApiProperty({ minimum: 100, maximum: 50000 })
  @IsInt()
  @Min(100)
  @Max(50000)
  questionCount!: number;

  @ApiProperty({ type: DifficultyMixDto })
  @ValidateNested()
  @Type(() => DifficultyMixDto)
  @IsObject()
  difficulty!: DifficultyMixDto;

  @ApiProperty({ enum: ['append', 'replace'] })
  @IsEnum(['append', 'replace'] as const)
  mode!: 'append' | 'replace';
}

export class PmTestPreviewDto {
  @ApiProperty({ enum: ExamType })
  @IsEnum(ExamType)
  examType!: ExamType;

  @ApiProperty({ isArray: true, type: PmTestSelectionDto })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PmTestSelectionDto)
  selections!: PmTestSelectionDto[];

  @ApiProperty({ enum: ['claude-haiku', 'claude-sonnet'] })
  @IsEnum(['claude-haiku', 'claude-sonnet'] as const)
  model!: 'claude-haiku' | 'claude-sonnet';

  @ApiProperty()
  @IsBoolean()
  includeExplanations!: boolean;

  @ApiProperty({ minimum: 1, maximum: 50 })
  @IsInt()
  @Min(1)
  @Max(50)
  batchSize!: number;
}

export class PmTestGenerateDto extends PmTestPreviewDto {
  @ApiProperty({
    description: 'Confirmation token returned by /admin/pm-test/preview.',
  })
  @IsString()
  confirmationToken!: string;
}

export class PmTestReviewItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;

  @ApiProperty({ enum: ['approve', 'reject', 'edit'] })
  @IsEnum(['approve', 'reject', 'edit'] as const)
  action!: 'approve' | 'reject' | 'edit';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  explanation?: string;
}

export class PmTestReviewBulkDto {
  @ApiProperty({ isArray: true, type: PmTestReviewItemDto })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PmTestReviewItemDto)
  items!: PmTestReviewItemDto[];
}
