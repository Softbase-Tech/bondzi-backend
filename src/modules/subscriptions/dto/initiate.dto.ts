import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsUUID } from 'class-validator';
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
  @ApiProperty()
  reference!: string;
}
