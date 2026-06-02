import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  AccountType,
  ExamType,
  PaymentKind,
} from '../../../../common/types/enums';

export class CreatePlanDto {
  @ApiProperty({ example: 'Bondzi Pro · WASSCE' })
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

  @ApiProperty({
    enum: AccountType,
    example: AccountType.PRO,
    description:
      'Plan grade. `plus` = lifetime per-level access. `pro` = recurring per-level subscription with AI features. `free` is implicit and never stored as a plan.',
  })
  @IsEnum(AccountType)
  account!: AccountType;

  @ApiProperty({
    enum: ExamType,
    example: ExamType.WASSCE,
    description:
      'Which exam-platform the plan unlocks. Plus/Pro are scoped per level — a user must purchase separately for each.',
  })
  @IsEnum(ExamType)
  level!: ExamType;

  @ApiProperty({
    enum: PaymentKind,
    example: PaymentKind.RECURRING,
    description:
      '`one_time` (Plus, no recurring) or `recurring` (Pro, Paystack-managed subscription).',
  })
  @IsEnum(PaymentKind)
  paymentKind!: PaymentKind;

  @ApiPropertyOptional({
    default: 0,
    minimum: 0,
    maximum: 100,
    description:
      'VAT (or VAT-equivalent levy stack) baked into the displayed price. Stored INCLUSIVELY: a 15% rate on a 200 GHS plan means the user pays 200 at checkout and the PDF receipt breaks it into ~173.91 net + ~26.09 VAT.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  vatRatePct?: number;

  @ApiProperty({
    example: 29,
    minimum: 0.01,
    description:
      'For recurring plans: the monthly price. For one-time plans: the single headline price (the only price field used; six-month and annual are ignored).',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  monthlyPrice!: number;

  @ApiPropertyOptional({
    example: 150,
    minimum: 0,
    description:
      'Recurring plans only — six-month cadence price. Defaults to 0 for one-time plans.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  sixMonthPrice?: number;

  @ApiPropertyOptional({
    example: 240,
    minimum: 0,
    description:
      'Recurring plans only — annual cadence price. Defaults to 0 for one-time plans.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  annualPrice?: number;

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
