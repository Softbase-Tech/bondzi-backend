import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum } from 'class-validator';
import { ExamType, LeaderboardPeriodType } from '../../../common/types/enums';

export class SelectWinnersDto {
  @ApiProperty({ enum: ExamType })
  @IsEnum(ExamType)
  examType!: ExamType;

  @ApiProperty({ enum: LeaderboardPeriodType })
  @IsEnum(LeaderboardPeriodType)
  periodType!: LeaderboardPeriodType;

  @ApiProperty({ example: '2026-04-20', description: 'YYYY-MM-DD' })
  @IsDateString()
  periodStart!: string;
}
