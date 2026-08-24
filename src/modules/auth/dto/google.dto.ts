import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsJWT,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ExamType } from '../../../common/types/enums';
import { SignupAttributionDto } from './signup-attribution.dto';

// See RegisterDto — Google sign-in also creates users, so it carries the
// same attribution fields.
export class GoogleSignInDto extends SignupAttributionDto {
  @ApiProperty({ description: 'Google ID token issued by the mobile SDK' })
  @IsJWT()
  idToken!: string;

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

  // Only required when Google sign-in is creating a brand-new user.
  @ApiPropertyOptional({ enum: ExamType })
  @IsOptional()
  @IsEnum(ExamType)
  examType?: ExamType;

  @ApiPropertyOptional({ minimum: 1, maximum: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  formLevel?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  referralCode?: string;
}
