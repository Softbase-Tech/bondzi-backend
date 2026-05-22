import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, IsUUID } from 'class-validator';
import { BillingInterval } from '../../../common/types/enums';

export class InitiateSubscriptionDto {
  @ApiProperty({ format: 'uuid', description: 'Plan row to subscribe to.' })
  @IsUUID()
  planId!: string;

  @ApiProperty({
    enum: BillingInterval,
    description: 'Which cadence within the plan to purchase.',
  })
  @IsEnum(BillingInterval)
  interval!: BillingInterval;
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
