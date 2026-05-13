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
import { AuthProvider, ExamType } from '../../../common/types/enums';

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

  @ApiPropertyOptional({ description: 'Required when registering with email.' })
  @ValidateIf(
    (o: RegisterDto) => !!o.email && o.authProvider !== AuthProvider.GOOGLE,
  )
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/[A-Za-z]/, { message: 'password must include a letter' })
  @Matches(/\d/, { message: 'password must include a number' })
  password?: string;

  @ApiPropertyOptional({ enum: AuthProvider, default: AuthProvider.EMAIL })
  @IsOptional()
  @IsEnum(AuthProvider)
  authProvider?: AuthProvider;

  @ApiProperty({ enum: ExamType })
  @IsEnum(ExamType)
  examType!: ExamType;

  @ApiProperty({ minimum: 1, maximum: 3 })
  @IsInt()
  @Min(1)
  @Max(3)
  formLevel!: number;

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
