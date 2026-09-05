import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

/**
 * Query DTO for GET /admin/users. `search` must live ON the DTO —
 * mixing `@Query() PaginationDto` with a separate named
 * `@Query('search')` 400s under the global ValidationPipe
 * (forbidNonWhitelisted validates the whole query object against
 * PaginationDto, which doesn't declare `search`).
 */
export class ListUsersQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Name / username / email / phone' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}
