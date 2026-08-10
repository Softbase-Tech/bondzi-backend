import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class SuspendPartnerDto {
  @ApiProperty({ description: 'Reason surfaced on the partner audit trail.' })
  @IsString()
  @MinLength(3)
  @MaxLength(280)
  reason: string;
}
