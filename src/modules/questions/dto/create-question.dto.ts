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

/**
 * One worked-example block attached to a question's explanation.
 * Mirrors the runtime shape in `../types/worked-example.ts`. Stored as
 * a JSONB array on `questions.explanation_examples`.
 */
export class WorkedExampleDto {
  @ApiPropertyOptional({
    description:
      'Optional human-readable label shown above the example, e.g. "Example 1" or "Alternative method".',
    maxLength: 80,
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  caption?: string;

  @ApiProperty({
    description: 'The example scenario / question. Markdown source.',
  })
  @IsString()
  @MaxLength(4000)
  prompt!: string;

  @ApiProperty({
    description: 'The worked-out answer. Markdown source.',
  })
  @IsString()
  @MaxLength(8000)
  solution!: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Optional ordered bullets when the solution has discrete steps. Each entry is a markdown line.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  steps?: string[];

  @ApiPropertyOptional({
    description:
      'Optional diagram / figure URL for this example. Same CDN shape as question imageUrl.',
  })
  @IsOptional()
  @IsString()
  // We don't require strict URL validation because admins sometimes
  // paste relative paths or data URLs during import; the storage
  // layer rejects invalid URLs when the mobile renders. Use IsString
  // + MaxLength to bound payload size.
  @MaxLength(2048)
  imageUrl?: string;
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

  /**
   * Optional inline explanation paragraph (markdown). When set during
   * bulk import the service writes it to `explanation` and stamps
   * `explanation_model='manual'` + `explanation_generated_at=now()`
   * so the admin dashboard can later distinguish manual from
   * AI-generated rows. Backward compatible: omit and the question
   * is created with no explanation, exactly as before.
   */
  @ApiPropertyOptional({
    description:
      'Optional explanation paragraph (markdown). Manual imports stamp explanation_model="manual".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  explanation?: string;

  /**
   * Optional worked examples that supplement the explanation. Stored
   * as a JSONB array on `questions.explanation_examples`. REPLACES
   * any existing examples on a re-import (idempotent semantics).
   */
  @ApiPropertyOptional({ type: [WorkedExampleDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkedExampleDto)
  explanationExamples?: WorkedExampleDto[];
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

  /**
   * Optional explanation paragraph (markdown). Setting on update
   * overwrites the existing value AND stamps
   * `explanation_model='manual'` + `explanation_generated_at=now()`.
   */
  @ApiPropertyOptional({
    description:
      'Optional explanation paragraph (markdown). Manual edit stamps explanation_model="manual".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  explanation?: string;

  /**
   * Optional worked examples — pass an empty array to clear, omit
   * to leave the existing examples untouched. REPLACES on a value.
   */
  @ApiPropertyOptional({ type: [WorkedExampleDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkedExampleDto)
  explanationExamples?: WorkedExampleDto[];
}

export class BulkImportDto {
  @ApiProperty({ type: [CreateQuestionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateQuestionDto)
  questions!: CreateQuestionDto[];
}

/**
 * Per-row shape for the bulk explanations import. Targets an existing
 * question by id (admin uses the question detail page to find these)
 * and overwrites its explanation + examples. Idempotent: re-running
 * with the same payload yields the same row state.
 */
export class BulkExplanationImportRowDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  questionId!: string;

  @ApiProperty({
    description:
      'The explanation paragraph for this question. Markdown source. REPLACES any existing explanation.',
  })
  @IsString()
  @MaxLength(8000)
  explanation!: string;

  @ApiPropertyOptional({
    type: [WorkedExampleDto],
    description:
      'Optional worked examples. REPLACES any existing examples on this question — pass an empty array to clear.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkedExampleDto)
  explanationExamples?: WorkedExampleDto[];
}

export class BulkImportExplanationsDto {
  @ApiProperty({ type: [BulkExplanationImportRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BulkExplanationImportRowDto)
  explanations!: BulkExplanationImportRowDto[];
}
