import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Login accepts either `email + password` OR `phone + password`. The
 * mobile login screen sends whichever the user typed; the backend
 * resolves the user record from whichever identifier is present.
 *
 * Phone OTP login is no longer supported — `OTP only works for
 * password reset` (per launch decision). Phone users can still sign
 * in via password.
 */
export class LoginDto {
  @ApiPropertyOptional()
  @ValidateIf((o: LoginDto) => !o.phone)
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'E.164 phone, e.g. +233201234567' })
  @ValidateIf((o: LoginDto) => !o.email)
  @IsPhoneNumber('GH')
  phone?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  password!: string;

  @ApiPropertyOptional({
    description:
      'Stable device fingerprint. Prefer the X-Device-ID header; body is a fallback.',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  deviceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;
}
