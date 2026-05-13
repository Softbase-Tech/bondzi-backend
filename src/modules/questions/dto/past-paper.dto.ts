import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

function toInt(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.length > 0) return parseInt(value, 10);
  return undefined;
}

export class PastPaperQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  subjectId!: string;

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => toInt(value))
  @IsInt()
  @Min(1990)
  @Max(2100)
  year!: number;

  @ApiPropertyOptional({ description: '1 or 2' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toInt(value))
  @IsInt()
  @Min(1)
  @Max(2)
  paper?: number;
}

export class AdaptiveQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  subjectId!: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toInt(value) ?? 20)
  @IsInt()
  @Min(1)
  @Max(50)
  count?: number = 20;
}
