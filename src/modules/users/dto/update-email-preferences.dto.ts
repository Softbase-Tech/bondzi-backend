import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateEmailPreferencesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  weeklyDigest?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  streakNudges?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  levelUp?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  marketing?: boolean;
}
