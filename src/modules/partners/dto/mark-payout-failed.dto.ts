import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Admin marks a payout FAILED (MoMo bounce, wrong number, etc.). The
 * reason is appended to the payout's `notes` for audit; commissions
 * revert to APPROVED so a fresh payout can be created.
 */
export class MarkPayoutFailedDto {
  @ApiProperty({ description: 'Why the payout failed. Free-form text.' })
  @IsString()
  @MinLength(3)
  @MaxLength(280)
  reason: string;
}
