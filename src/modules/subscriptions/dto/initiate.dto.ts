import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { BillingInterval } from '../../../common/types/enums';

export class InitiateSubscriptionDto {
  @ApiProperty({ format: 'uuid', description: 'Plan row to subscribe to.' })
  @IsUUID()
  planId!: string;

  /**
   * Required for recurring (Pro) plans; MUST be omitted for one-time
   * (Plus) plans. The service validates the combination against the
   * plan's `payment_kind` and returns 400 on mismatch.
   */
  @ApiPropertyOptional({
    enum: BillingInterval,
    description:
      'Billing cadence for recurring plans. Omit for one-time (Plus) plans.',
  })
  @IsOptional()
  @IsEnum(BillingInterval)
  interval?: BillingInterval;

  /**
   * Optional promo code applied at checkout. Validated server-side via
   * PromoCodesService.quote — invalid / scoped-out / exhausted codes
   * yield 400 with a precise reason. Stored on the subscription row
   * (`promo_code_id`) and the redemption ledger (`promo_redemptions`)
   * after `verify()` confirms the charge.
   */
  @ApiPropertyOptional({
    description:
      'Discount code (case-insensitive). Validated against PromoCodesService at initiate time.',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  promoCode?: string;
}

export class VerifySubscriptionDto {
  /**
   * The Paystack reference issued by POST /subscriptions/initiate.
   * MUST carry a class-validator decorator — the global ValidationPipe
   * has `whitelist: true, forbidNonWhitelisted: true`, so a property
   * without a decorator gets stripped from the body AND triggers a
   * 400 "property reference should not exist". That was the bug.
   */
  @ApiProperty({ description: 'Server-issued Paystack reference' })
  @IsString()
  @IsNotEmpty()
  reference!: string;
}
