import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { NotificationChannel } from '../../../common/types/enums';

export enum BroadcastSegment {
  ALL = 'all',
  FREE = 'free',
  PAID = 'paid',
  EXPIRING_SOON = 'expiring_soon',
  CUSTOM = 'custom',
}

export class BroadcastNotificationDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title: string;

  @ApiProperty()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  body: string;

  @ApiProperty({ enum: NotificationChannel, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(NotificationChannel, { each: true })
  channels: NotificationChannel[];

  @ApiProperty({ enum: BroadcastSegment })
  @IsEnum(BroadcastSegment)
  segment: BroadcastSegment;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  region?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
