import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  Difficulty,
  ExamType,
  QuestionSource,
  QuestionType,
} from '../../../common/types/enums';

export class CreateOptionDto {
  @ApiProperty({ example: 'A', maxLength: 2 })
  @IsString()
  @MaxLength(2)
  label!: string;

  @ApiProperty()
  @IsString()
  body!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiProperty()
  @IsBoolean()
  isCorrect!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class CreateQuestionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  subjectId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  topicId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Optional shared stimulus FK. Multiple questions sharing the same stimulus_id render as one group on mobile.',
  })
  @IsOptional()
  @IsUUID()
  stimulusId?: string;

  // Spec §3.1: every bulk-imported question must carry its examType.
  @ApiProperty({ enum: ExamType })
  @IsEnum(ExamType)
  examType!: ExamType;

  @ApiProperty({ enum: QuestionType, default: QuestionType.MCQ })
  @IsEnum(QuestionType)
  questionType!: QuestionType;

  @ApiProperty({ enum: QuestionSource })
  @IsEnum(QuestionSource)
  source!: QuestionSource;

  @ApiProperty()
  @IsString()
  body!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1990)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  wassecPaper?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4)
  section?: string;

  @ApiProperty({ enum: Difficulty, default: Difficulty.MEDIUM })
  @IsEnum(Difficulty)
  difficulty!: Difficulty;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ type: [CreateOptionDto], minItems: 2 })
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => CreateOptionDto)
  options!: CreateOptionDto[];
}

/**
 * Every field is optional — admins rarely change everything at once. Scalar
 * fields are applied via Object.assign in the service. If `options` is
 * provided, the service replaces the full option set (simpler than diffing;
 * option IDs are referenced from exam_answers, so we keep references intact
 * by clearing and re-creating).
 */
export class UpdateQuestionDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  topicId?: string;

  /**
   * Pass `null` to detach a stimulus from a question, a UUID to attach one,
   * or omit the field to leave it unchanged. The validator accepts either
   * `null` or a UUID — the service interprets undefined as "no change".
   */
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Pass null to detach the stimulus, UUID to attach.',
  })
  @IsOptional()
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  @IsUUID()
  stimulusId?: string | null;

  @ApiPropertyOptional({ enum: QuestionType })
  @IsOptional()
  @IsEnum(QuestionType)
  questionType?: QuestionType;

  @ApiPropertyOptional({ enum: QuestionSource })
  @IsOptional()
  @IsEnum(QuestionSource)
  source?: QuestionSource;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1990)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  wassecPaper?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4)
  section?: string;

  @ApiPropertyOptional({ enum: Difficulty })
  @IsOptional()
  @IsEnum(Difficulty)
  difficulty?: Difficulty;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: [CreateOptionDto], minItems: 2 })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => CreateOptionDto)
  options?: CreateOptionDto[];
}

export class BulkImportDto {
  @ApiProperty({ type: [CreateQuestionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateQuestionDto)
  questions!: CreateQuestionDto[];
}
