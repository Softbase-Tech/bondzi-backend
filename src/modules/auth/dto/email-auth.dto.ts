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
 * Password-reset request. Accepts EITHER `email` OR `phone`. Exactly
 * one must be present — DTO validators enforce that. Both channels
 * send a 6-digit OTP code (email → EMAIL_OTP mail, phone → SMS OTP).
 * Link-based email resets were retired in favour of OTP everywhere.
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
 * Reset accepts two mutually-exclusive shapes, both OTP-based:
 *   1. Email-OTP reset:  `{ email, otp, password }`  — the code came
 *      from the email sent by /auth/forgot-password { email }.
 *   2. Phone-OTP reset:  `{ phone, otp, password }`  — the code came
 *      from the SMS sent by /auth/forgot-password { phone }.
 *
 * The service layer routes on whichever identifier is present. `token`
 * is no longer accepted — link-based reset was retired.
 */
export class ResetPasswordDto {
  @ApiPropertyOptional({ example: 'student@example.com' })
  @ValidateIf((o: ResetPasswordDto) => !o.phone)
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '+233201234567' })
  @ValidateIf((o: ResetPasswordDto) => !o.email)
  @IsPhoneNumber('GH')
  phone?: string;

  @ApiProperty({ description: '6-digit OTP code (email or SMS)' })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'otp must be 6 digits' })
  otp!: string;

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
