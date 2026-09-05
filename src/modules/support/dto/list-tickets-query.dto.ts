import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

const STATUSES = ['open', 'closed'] as const;
const CATEGORIES = [
  'feedback',
  'wrong_question',
  'payment',
  'general',
] as const;

/**
 * Query DTO for the admin support queue. Filters live ON the DTO —
 * mixing `@Query() PaginationDto` with separate named @Query params
 * 400s under the global ValidationPipe (forbidNonWhitelisted).
 */
export class ListTicketsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({ enum: CATEGORIES })
  @IsOptional()
  @IsIn(CATEGORIES)
  category?: (typeof CATEGORIES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}
