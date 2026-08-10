import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MomoProvider } from '../../../common/types/enums';

/**
 * Payload for `POST /partner/register`. Called by a signed-in
 * student who wants to become a partner. MoMo details are captured
 * up-front so the first Monday-morning payout can go out without a
 * follow-up form.
 */
export class RegisterPartnerDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  phone!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({ enum: MomoProvider })
  @IsEnum(MomoProvider)
  momoProvider!: MomoProvider;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(/^[0-9+ -]+$/, {
    message: 'MoMo number may only contain digits, spaces, dashes or +.',
  })
  momoNumber!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  momoAccountName!: string;
}
