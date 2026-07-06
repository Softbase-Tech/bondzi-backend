import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ExamType } from '../../../common/types/enums';

/**
 * DTOs for the syllabus-topics surface. Kept small and denormalised
 * (no nested relations) because bulk-import parses these by the
 * hundred and the JSON payload should be simple to author from a
 * spreadsheet export.
 */

export class CreateSyllabusTopicDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  subjectId!: string;

  @ApiProperty({ enum: ExamType })
  @IsEnum(ExamType)
  examType!: ExamType;

  @ApiProperty({ minimum: 1, maximum: 3 })
  @IsInt()
  @Min(1)
  @Max(3)
  formLevel!: number;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateSyllabusTopicDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Bulk-import body. Accepts up to `AI_MAX_ITEMS_PER_BATCH` items
 * (default 200); the service enforces that ceiling before the
 * transaction begins so a mistyped batch doesn't lock the table.
 *
 * The whole array is inserted in one transaction with
 * `INSERT ... ON CONFLICT ("subject_id", "exam_type", "form_level", "title")
 * WHERE is_active=true DO UPDATE ...` — so re-importing the same
 * spreadsheet is idempotent: existing rows get their description /
 * sortOrder refreshed, new rows insert, nothing duplicates.
 */
export class BulkSyllabusTopicDto {
  @ApiProperty({ type: [CreateSyllabusTopicDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000) // hard schema cap; service enforces the config-driven cap too
  @ValidateNested({ each: true })
  @Type(() => CreateSyllabusTopicDto)
  items!: CreateSyllabusTopicDto[];
}

export class ListSyllabusTopicsQueryDto {
  @ApiPropertyOptional({ enum: ExamType })
  @IsOptional()
  @IsEnum(ExamType)
  examType?: ExamType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  subjectId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 3 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  formLevel?: number;
}
