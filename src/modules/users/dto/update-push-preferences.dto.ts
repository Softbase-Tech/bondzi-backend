import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Client-facing shape for updating push preferences. Mirrors
 * UpdateEmailPreferencesDto — flat, all-optional, PATCH semantics
 * (undefined = leave alone). Two flags today:
 *
 *   reminders     — daily 10:00 + Monday leaderboard push
 *   streakNudges  — 17:00 "streak at risk" push
 */
export class UpdatePushPreferencesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  reminders?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  streakNudges?: boolean;
}
