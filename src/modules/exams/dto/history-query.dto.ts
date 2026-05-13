import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ExamMode, ExamStatus } from '../../../common/types/enums';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class HistoryQueryDto extends PaginationDto {
  /** Restrict to exams that included this subject in `subjectFilter.subjectIds`. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  /** ISO 8601 lower bound on `completed_at`. */
  @ApiPropertyOptional({
    description: 'ISO 8601 inclusive lower bound on completed_at',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  fromDate?: Date;

  /** ISO 8601 upper bound on `completed_at`. */
  @ApiPropertyOptional({
    description: 'ISO 8601 inclusive upper bound on completed_at',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  toDate?: Date;

  @ApiPropertyOptional({ enum: ExamMode })
  @IsOptional()
  @IsEnum(ExamMode)
  mode?: ExamMode;

  /** Defaults to `completed` if omitted — the home screen passes
   * `in_progress` to surface "Continue where you left off". */
  @ApiPropertyOptional({ enum: ExamStatus, default: ExamStatus.COMPLETED })
  @IsOptional()
  @IsEnum(ExamStatus)
  status?: ExamStatus;
}
