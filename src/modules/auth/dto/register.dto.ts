import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ExamType } from '../../../common/types/enums';

export class RegisterDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName!: string;

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
    description: 'PM-XXXX-XXX referral code from another user.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  referralCode?: string;

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
