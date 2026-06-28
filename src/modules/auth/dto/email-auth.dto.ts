import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Length,
  Matches,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Password-reset request. Accepts EITHER `email` (sends a reset
 * link) OR `phone` (sends a 6-digit SMS OTP). Exactly one must be
 * present — DTO validators enforce that.
 *
 * Phone-only registered users would otherwise be locked out if they
 * forgot their password — the link-based reset can't reach them.
 */
export class ForgotPasswordDto {
  @ApiPropertyOptional({ example: 'student@example.com' })
  @ValidateIf((o: ForgotPasswordDto) => !o.phone)
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '+233201234567' })
  @ValidateIf((o: ForgotPasswordDto) => !o.email)
  @IsPhoneNumber('GH')
  phone?: string;
}

/**
 * Reset accepts two mutually-exclusive shapes:
 *   1. Email-link reset: `{ token, password }` — token is the one
 *      delivered by the password-reset email.
 *   2. Phone-OTP reset: `{ phone, otp, password }` — the OTP came
 *      from the SMS issued by /auth/forgot-password.
 *
 * The service layer routes on which fields are present.
 */
export class ResetPasswordDto {
  @ApiPropertyOptional({ description: 'Email-reset token (URL token).' })
  @ValidateIf((o: ResetPasswordDto) => !o.phone && !o.otp)
  @IsString()
  token?: string;

  @ApiPropertyOptional({ example: '+233201234567' })
  @ValidateIf((o: ResetPasswordDto) => !o.token)
  @IsPhoneNumber('GH')
  phone?: string;

  @ApiPropertyOptional({ description: '6-digit SMS OTP' })
  @ValidateIf((o: ResetPasswordDto) => !o.token)
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'otp must be 6 digits' })
  otp?: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  @Matches(/[A-Za-z]/, { message: 'password must include a letter' })
  @Matches(/\d/, { message: 'password must include a number' })
  password!: string;

  /** Kept for future ergonomics — class-validator imports cleanliness. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deviceId?: string;
}

export class VerifyEmailQueryDto {
  @ApiProperty()
  @IsString()
  token!: string;
}
