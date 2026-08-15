import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Whitelist-only profile update. `role`, `isActive`, `passwordHash`, `email`,
 * `phone` are deliberately NOT accepted here — those flow through dedicated
 * endpoints (password, admin ban, OTP rebind).
 */
export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  formLevel?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  schoolName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  region?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;

  /**
   * ISO date `YYYY-MM-DD` of the student's next exam sitting, OR
   * `null` to clear a previously-set date. Service layer enforces
   * "in the future, within five years"; a `null` value is accepted
   * and passed straight through so a user can un-set the countdown
   * from the profile UI.
   */
  @ApiPropertyOptional({
    description:
      'ISO date YYYY-MM-DD of the upcoming exam sitting, or null to clear.',
    example: '2027-05-15',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o: UpdateProfileDto, v: unknown) => v !== null)
  @IsDateString({ strict: true })
  targetExamDate?: string | null;
}
