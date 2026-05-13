import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { FlagReason } from '../../../common/types/enums';

export class FlagQuestionDto {
  @ApiProperty({ enum: FlagReason })
  @IsEnum(FlagReason)
  reason!: FlagReason;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
