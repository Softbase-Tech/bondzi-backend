import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

export class CreatePlanDto {
  @ApiProperty({ example: 'PassMaster Pro GH' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 'GH', description: 'ISO-3166 alpha-2' })
  @IsString()
  @Length(2, 2)
  countryCode!: string;

  @ApiProperty({ example: 'GHS', description: 'ISO-4217' })
  @IsString()
  @Length(3, 3)
  currency!: string;

  @ApiProperty({
    example: 'paystack',
    description: 'Must match a registered PaymentProvider name.',
  })
  @IsString()
  @IsNotEmpty()
  provider!: string;

  @ApiProperty({ example: 29, minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  monthlyPrice!: number;

  @ApiProperty({ example: 150, minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  sixMonthPrice!: number;

  @ApiProperty({ example: 240, minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  annualPrice!: number;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  monthlyDurationDays?: number;

  @ApiPropertyOptional({ default: 180 })
  @IsOptional()
  @IsInt()
  @Min(1)
  sixMonthDurationDays?: number;

  @ApiPropertyOptional({ default: 365 })
  @IsOptional()
  @IsInt()
  @Min(1)
  annualDurationDays?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Mark as the default plan for this country. Clears the flag on any other plan in the same country.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({
    default: true,
    description:
      'When true, immediately creates the three provider plans. When false, the plan is stored with null provider codes and must be synced later via POST /admin/plans/:id/sync.',
  })
  @IsOptional()
  @IsBoolean()
  syncProvider?: boolean;
}
