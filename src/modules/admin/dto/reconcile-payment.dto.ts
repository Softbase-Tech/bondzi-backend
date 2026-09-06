import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { BillingInterval } from '../../../common/types/enums';

/**
 * Admin payment reconciliation: verify a Paystack reference
 * server-to-server and pull the money into the books through the
 * normal activation path. The overrides exist for transactions whose
 * metadata can't identify the user/plan (e.g. Inline-popup retries
 * initialized by Paystack itself).
 */
export class ReconcilePaymentDto {
  @ApiProperty({ description: 'Paystack transaction reference' })
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._=-]+$/, {
    message: 'reference contains characters Paystack never issues',
  })
  reference!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  planId?: string;

  @ApiPropertyOptional({ enum: BillingInterval })
  @IsOptional()
  @IsEnum(BillingInterval)
  interval?: BillingInterval;
}
