import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsPhoneNumber,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SendOtpDto {
  @ApiProperty({ description: 'E.164 phone number, e.g. +233201234567' })
  @IsPhoneNumber('GH')
  phone!: string;
}

export class VerifyOtpDto {
  @ApiProperty()
  @IsPhoneNumber('GH')
  phone!: string;

  @ApiProperty({ minLength: 4, maxLength: 8 })
  @IsString()
  @Length(4, 8)
  code!: string;

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
