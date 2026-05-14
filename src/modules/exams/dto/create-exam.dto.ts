import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ExamMode } from '../../../common/types/enums';

export enum ExamDifficultyFilter {
  EASY = 'easy',
  MEDIUM = 'medium',
  HARD = 'hard',
  MIXED = 'mixed',
}

export class ExamSubjectFilterDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  subjectIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  topicIds?: string[];

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  years?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  wassecPaper?: number;
}

export class CreateExamDto {
  @ApiProperty({ enum: ExamMode })
  @IsEnum(ExamMode)
  mode!: ExamMode;

  @ApiProperty({ type: ExamSubjectFilterDto })
  @ValidateNested()
  @Type(() => ExamSubjectFilterDto)
  subjectFilter!: ExamSubjectFilterDto;

  @ApiPropertyOptional({
    description: 'Desired question count',
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  questionCount?: number;

  @ApiPropertyOptional({
    description: 'Exam length in seconds (null for untimed)',
    minimum: 60,
  })
  @IsOptional()
  @IsInt()
  @Min(60)
  durationSeconds?: number;

  @ApiPropertyOptional({
    enum: ExamDifficultyFilter,
    description:
      'Difficulty filter for practice mode. "mixed" (default) returns the full range; specific values constrain questions.difficulty. Ignored for past_paper mode.',
  })
  @IsOptional()
  @IsEnum(ExamDifficultyFilter)
  difficulty?: ExamDifficultyFilter;

  @ApiPropertyOptional({
    description:
      "Practice mode only. When true, the server biases selection toward topics the user has a low accuracy on (<50% rolling), falling back to the provided filter if there aren't enough weak-topic questions.",
  })
  @IsOptional()
  @IsBoolean()
  focusWeak?: boolean;
}

export class SubmitAnswerDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  questionId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  selectedOptionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  typedAnswer?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  timeSpentMs?: number;
}
