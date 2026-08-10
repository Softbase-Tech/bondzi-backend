import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Admin fills the MoMo transfer reference after doing the manual
 * MoMo send from the ops phone. Required so the payout row + partner
 * email carry the exact reference the partner will see on their MoMo
 * statement — cash-vs-record reconciliation depends on it.
 */
export class MarkPayoutPaidDto {
  @ApiProperty({
    description:
      'MoMo transfer reference (the ID the MoMo dashboard issued for the send).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  momoReference: string;
}
