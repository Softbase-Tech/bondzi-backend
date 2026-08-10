import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MomoProvider } from '../../../common/types/enums';

/**
 * Payload for `PATCH /partner/me/momo`. All fields optional so the
 * partner can change a single field without re-sending the rest.
 */
export class UpdatePartnerMomoDto {
  @ApiPropertyOptional({ enum: MomoProvider })
  @IsOptional()
  @IsEnum(MomoProvider)
  momoProvider?: MomoProvider;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  @Matches(/^[0-9+ -]+$/)
  momoNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  momoAccountName?: string;
}
