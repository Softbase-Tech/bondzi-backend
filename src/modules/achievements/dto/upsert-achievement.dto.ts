import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import type { AchievementMetricKey } from '../entities/achievement.entity';

const METRIC_KEYS: AchievementMetricKey[] = [
  'answers_count',
  'streak_max',
  'longest_streak',
  'accuracy_pct',
  'level',
];

// Simple hex-with-optional-alpha match. The DB stores whatever the
// admin puts in — this validator just fences off obvious typos.
const HEX_COLOR = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Body for both `POST /admin/achievements` (all fields required) and
 * `PATCH /admin/achievements/:id` (all fields optional at the DTO
 * layer). The service enforces that a `PATCH` doesn't zero out
 * required columns.
 */
export class UpsertAchievementDto {
  @ApiPropertyOptional({
    description:
      'Stable slug used by the mobile client. Unique per achievement (active or not). Letters, digits, hyphens; kebab-case is the convention.',
    example: 'first-100',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'key must be kebab-case (lowercase letters, digits, hyphens)',
  })
  key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @ApiPropertyOptional({
    enum: METRIC_KEYS,
    description:
      'Which stat drives the unlock. answers_count → cumulative questions answered; streak_max → max(current, longest); longest_streak → longest strictly; accuracy_pct → rolling accuracy percent (see min_answers); level → gamification level.',
  })
  @IsOptional()
  @IsIn(METRIC_KEYS)
  metricKey?: AchievementMetricKey;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  thresholdValue?: number;

  @ApiPropertyOptional({
    description:
      'Optional lower bound on `answers_count` gating the unlock. Used by accuracy_pct to prevent 100% off two lucky guesses.',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  minAnswers?: number | null;

  @ApiPropertyOptional({
    description:
      'Icon key mapped to a bundled IconName on the mobile client. Fixed set: check, flame, sparkle, star, trophy, lightning.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  iconKey?: string;

  @ApiPropertyOptional({ description: '#RRGGBB or #RRGGBBAA' })
  @IsOptional()
  @Matches(HEX_COLOR, { message: 'gradientStart must be a #RRGGBB[AA] hex' })
  gradientStart?: string;

  @ApiPropertyOptional({ description: '#RRGGBB or #RRGGBBAA' })
  @IsOptional()
  @Matches(HEX_COLOR, { message: 'gradientEnd must be a #RRGGBB[AA] hex' })
  gradientEnd?: string;

  @ApiPropertyOptional({
    description:
      'Lower value renders further left in the strip. Non-unique — mobile falls back to `created_at` when two rows tie.',
  })
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
 * `POST /admin/achievements` body — the create path. Same shape as
 * the update DTO, but the fundamental identity fields (key, title,
 * metric, threshold, icon, both gradient stops) become required.
 * Written standalone rather than extending UpsertAchievementDto so
 * TypeScript's `useDefineForClassFields` doesn't complain about
 * property redeclaration.
 */
export class CreateAchievementDto {
  @ApiProperty({
    description:
      'Stable slug used by the mobile client. Unique per achievement (active or not). Letters, digits, hyphens; kebab-case is the convention.',
    example: 'first-100',
  })
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'key must be kebab-case (lowercase letters, digits, hyphens)',
  })
  key!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(80)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @ApiProperty({ enum: METRIC_KEYS })
  @IsIn(METRIC_KEYS)
  metricKey!: AchievementMetricKey;

  @ApiProperty()
  @IsInt()
  @Min(1)
  thresholdValue!: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  minAnswers?: number | null;

  @ApiProperty()
  @IsString()
  @MaxLength(40)
  iconKey!: string;

  @ApiProperty({ description: '#RRGGBB or #RRGGBBAA' })
  @Matches(HEX_COLOR, { message: 'gradientStart must be a #RRGGBB[AA] hex' })
  gradientStart!: string;

  @ApiProperty({ description: '#RRGGBB or #RRGGBBAA' })
  @Matches(HEX_COLOR, { message: 'gradientEnd must be a #RRGGBB[AA] hex' })
  gradientEnd!: string;

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
