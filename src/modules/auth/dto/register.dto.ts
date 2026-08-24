import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ExamType, Gender } from '../../../common/types/enums';
import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_REGEX,
} from '../../users/username.rules';
import { SignupAttributionDto } from './signup-attribution.dto';

// Extends SignupAttributionDto so the six optional utm* fields are
// whitelisted here too — `forbidNonWhitelisted: true` would otherwise
// 400 the entire registration the moment a client starts sending them.
export class RegisterDto extends SignupAttributionDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName!: string;

  /**
   * Public handle shown on leaderboards. Required for new sign-ups
   * going forward. Format-only validation here (length + character
   * set); reserved-word and uniqueness checks happen in AuthService
   * after the body is validated, so the error surfaces against the
   * `username` key consistently regardless of which gate trips.
   */
  @ApiProperty({
    description:
      'Public handle. Letters and digits only, 6-24 chars, case-insensitive uniqueness.',
    minLength: USERNAME_MIN_LENGTH,
    maxLength: USERNAME_MAX_LENGTH,
    example: 'ekowmensah',
  })
  @IsString()
  @MinLength(USERNAME_MIN_LENGTH)
  @MaxLength(USERNAME_MAX_LENGTH)
  @Matches(USERNAME_REGEX, {
    message: 'username must be letters and numbers only (no spaces or symbols)',
  })
  username!: string;

  @ApiPropertyOptional()
  @ValidateIf((o: RegisterDto) => !o.phone)
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'E.164 format, e.g. +233201234567' })
  @ValidateIf((o: RegisterDto) => !o.email)
  @IsPhoneNumber('GH')
  phone?: string;

  // authProvider is intentionally NOT accepted from the client. Google
  // sign-in has its own endpoint (POST /auth/google) which sets the
  // provider server-side. Accepting it here would let a caller send
  // `{ authProvider: "GOOGLE", email: "x" }` and skip the password
  // requirement — any future code that branches on the provider
  // (e.g. "trust the email is verified for Google users") would then
  // be subvertible from the registration body.
  @ApiPropertyOptional({ description: 'Required when registering with email.' })
  @ValidateIf((o: RegisterDto) => !!o.email)
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/[A-Za-z]/, { message: 'password must include a letter' })
  @Matches(/\d/, { message: 'password must include a number' })
  password?: string;

  @ApiProperty({ enum: ExamType })
  @IsEnum(ExamType)
  examType!: ExamType;

  /**
   * Required for BECE / WASSCE. MUST be omitted (or null) for NOVDEC —
   * remedial students aren't enrolled by form. The `users.form_level`
   * column is nullable for exactly this case (see migration 1860).
   */
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 3,
    description:
      'Required for BECE / WASSCE; omit for NOVDEC (remedial students have no form).',
  })
  @ValidateIf((o: RegisterDto) => o.examType !== ExamType.NOVDEC)
  @IsInt()
  @Min(1)
  @Max(3)
  formLevel?: number | null;

  @ApiPropertyOptional({
    description:
      '7-character alphanumeric referral code from another user (e.g. A1B2CJO).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  referralCode?: string;

  /**
   * Partner referral code — different pool from `referralCode`. Links
   * the new user to a partner in the Partner Portal for cash
   * commission accrual. Case-insensitive, `PM-`/dash stripping happens
   * server-side. Silently no-ops on unknown / inactive codes so a
   * malformed code never blocks registration.
   */
  @ApiPropertyOptional({
    description:
      'Partner referral code (7-char alphanumeric, cash commissions).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  partnerReferralCode?: string;

  /**
   * Email OTP, required when registering with email. The OTP is issued
   * by POST /auth/email/otp/send and verified server-side here, BEFORE
   * the user row is created — so a brand-new email is proven to belong
   * to the signup device. On success the user is marked
   * `email_verified_at = NOW()` and the verify-link email is skipped.
   *
   * Optional in the DTO for backwards compatibility with phone-only
   * signups (kept available as a backend endpoint per the launch
   * spec — the mobile UI no longer surfaces it). AuthService enforces
   * "email present implies emailOtp required" at the service layer.
   */
  @ApiPropertyOptional({ description: '6-digit email OTP' })
  @ValidateIf((o: RegisterDto) => !!o.email)
  @IsString()
  @Length(6, 6, { message: 'emailOtp must be a 6-digit code' })
  @Matches(/^\d{6}$/, { message: 'emailOtp must be 6 digits' })
  emailOtp?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  /**
   * Date of birth as an ISO date (`YYYY-MM-DD`). Validation at the
   * service layer enforces sensible bounds (≥ 8 years old, in the
   * past, ≤ 100 years ago). DTO-level just confirms the wire shape.
   */
  @ApiPropertyOptional({
    description: 'ISO date YYYY-MM-DD',
    example: '2010-05-21',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  dateOfBirth?: string;

  /**
   * Optional at registration — the mobile onboarding asks "Do you
   * have an upcoming exam?" and lets the student pick a date. Service
   * layer enforces that the date is in the future and within a
   * plausible five-year window; unset here means the profile card
   * renders the "no exam date set" state and the student can add it
   * from Settings later.
   */
  @ApiPropertyOptional({
    description: 'ISO date YYYY-MM-DD of the upcoming exam sitting.',
    example: '2027-05-15',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  targetExamDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  schoolName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  region?: string;

  @ApiPropertyOptional({
    description:
      'Stable device fingerprint (UUID). Preferred transport is the X-Device-ID header; body is a fallback for tools that can not set headers.',
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
