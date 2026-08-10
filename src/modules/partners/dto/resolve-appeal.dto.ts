import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Admin resolution decision on an open appeal.
 *   upheld  — partner is reinstated (back to ACTIVE, strike counter
 *             reset). Note is optional but strongly encouraged.
 *   denied  — appeal is denied. Third denial auto-bans.
 */
export class ResolveAppealDto {
  @ApiProperty({ enum: ['upheld', 'denied'] })
  @IsIn(['upheld', 'denied'])
  decision!: 'upheld' | 'denied';

  @ApiPropertyOptional({
    description: 'Free-form message shown to the partner in the email.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  resolutionNote?: string;
}
