import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  Difficulty,
  ExamType,
  QuestionSource,
} from '../../../common/types/enums';

/**
 * Verify a specific set of question ids. Distinct from
 * `VerifyAllMatchingDto` so the intent stays legible: this shape
 * ships whatever the admin ticked in the table.
 */
export class VerifyBulkDto {
  @ApiProperty({ isArray: true, format: 'uuid' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  ids!: string[];
}

/**
 * Verify every unverified question matching this filter. Same shape
 * as QuestionQueryDto minus pagination — the intent is "mark
 * everything the current view represents as verified", so the
 * server treats it as one UPDATE across the whole matching set.
 */
export class VerifyAllMatchingDto {
  @ApiPropertyOptional({ enum: ExamType })
  @IsOptional()
  @IsEnum(ExamType)
  examType?: ExamType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  subjectId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  topicId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.length > 0)
      return parseInt(value, 10);
    return undefined;
  })
  @IsInt()
  @Min(1990)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({ enum: Difficulty })
  @IsOptional()
  @IsEnum(Difficulty)
  difficulty?: Difficulty;

  @ApiPropertyOptional({ enum: QuestionSource })
  @IsOptional()
  @IsEnum(QuestionSource)
  source?: QuestionSource;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;
}
