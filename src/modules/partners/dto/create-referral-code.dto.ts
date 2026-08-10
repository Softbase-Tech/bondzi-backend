import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload for `POST /partner/codes`. Partner supplies a label they
 * recognise ("Instagram Feb", "Whatsapp status"); the code string
 * itself is generated server-side to guarantee uniqueness.
 */
export class CreateReferralCodeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(60)
  label!: string;
}
