import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../admin/entities/audit-log.entity';
import { PaymentsModule } from '../payments/payments.module';
import { User } from '../users/entities/user.entity';
import { Subscription } from './entities/subscription.entity';
import { SubscriptionPlanEntity } from './plans/entities/subscription-plan.entity';
import { PlansAdminController } from './plans/plans-admin.controller';
import { PlansPublicController } from './plans/plans-public.controller';
import { PlansService } from './plans/plans.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Subscription,
      SubscriptionPlanEntity,
      User,
      AuditLog,
    ]),
    forwardRef(() => PaymentsModule),
  ],
  controllers: [
    SubscriptionsController,
    PlansPublicController,
    PlansAdminController,
  ],
  providers: [SubscriptionsService, PlansService],
  exports: [SubscriptionsService, PlansService, TypeOrmModule],
})
export class SubscriptionsModule {}
