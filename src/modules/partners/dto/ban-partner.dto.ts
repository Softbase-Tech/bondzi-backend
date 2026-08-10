import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Admin permanently bans a partner. Reason lands on the ban email
 * AND the audit trail — write it as if the partner will read it,
 * because they will.
 */
export class BanPartnerDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(280)
  reason!: string;
}
