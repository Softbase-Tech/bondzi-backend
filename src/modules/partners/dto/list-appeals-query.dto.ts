import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { PartnerAppealStatus } from '../../../common/types/enums';

/**
 * Query DTO for GET /admin/partners/appeals/list.
 *
 * Extends PaginationDto so `status` / `partnerId` are whitelisted
 * properties. Mixing `@Query() PaginationDto` with separate named
 * `@Query('status')` params — the previous shape — 400s under the
 * global ValidationPipe (`forbidNonWhitelisted`): the whole query
 * object is validated against PaginationDto, which doesn't declare
 * the extra keys.
 */
export class ListAppealsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @ApiPropertyOptional({ enum: PartnerAppealStatus })
  @IsOptional()
  @IsEnum(PartnerAppealStatus)
  status?: PartnerAppealStatus;
}
