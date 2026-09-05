import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import {
  PartnerCommissionStatus,
  PartnerCommissionType,
  PartnerFraudSeverity,
  PartnerPayoutStatus,
  PartnerStatus,
} from '../../../common/types/enums';

/**
 * Query DTOs for the partner-admin list endpoints. Filters must live
 * ON the DTO — mixing `@Query() PaginationDto` with separate named
 * `@Query('x')` params 400s under the global ValidationPipe
 * (forbidNonWhitelisted validates the entire query object against
 * PaginationDto, which doesn't declare the extra keys).
 */

export class ListPartnersQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: PartnerStatus })
  @IsOptional()
  @IsEnum(PartnerStatus)
  status?: PartnerStatus;

  @ApiPropertyOptional({ description: 'Name / email / code' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}

export class ListFraudEventsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @ApiPropertyOptional({ enum: PartnerFraudSeverity })
  @IsOptional()
  @IsEnum(PartnerFraudSeverity)
  severity?: PartnerFraudSeverity;

  /** String on the wire; the controller converts to boolean. */
  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  resolved?: 'true' | 'false';
}

export class ListCommissionsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @ApiPropertyOptional({ enum: PartnerCommissionStatus })
  @IsOptional()
  @IsEnum(PartnerCommissionStatus)
  status?: PartnerCommissionStatus;

  @ApiPropertyOptional({ enum: PartnerCommissionType })
  @IsOptional()
  @IsEnum(PartnerCommissionType)
  type?: PartnerCommissionType;
}

export class ListPayoutsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @ApiPropertyOptional({ enum: PartnerPayoutStatus })
  @IsOptional()
  @IsEnum(PartnerPayoutStatus)
  status?: PartnerPayoutStatus;
}
