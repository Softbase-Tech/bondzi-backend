import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class ListIndicatorsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  subjectId?: string;

  @ApiPropertyOptional({ enum: ['draft', 'approved'] })
  @IsOptional()
  @IsIn(['draft', 'approved'])
  status?: 'draft' | 'approved';

  @ApiPropertyOptional({
    description: 'Filter by embedding state: true = embedded, false = not.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : undefined,
  )
  @IsBoolean()
  embedded?: boolean;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? parseInt(value, 10) : (value as number),
  )
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? parseInt(value, 10) : (value as number),
  )
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}

export class ApproveAllDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Scope the bulk approve to one subject; omit to approve all.',
  })
  @IsOptional()
  @IsUUID('4')
  subjectId?: string;
}

export class UpdateIndicatorDto {
  @ApiPropertyOptional({ enum: ['draft', 'approved'] })
  @IsOptional()
  @IsIn(['draft', 'approved'])
  status?: 'draft' | 'approved';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  statement?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  workedContent?: string | null;

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  targetDokLevels?: number[] | null;
}
