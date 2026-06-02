import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../admin/entities/audit-log.entity';
import { PaymentsModule } from '../payments/payments.module';
import { PromoCodesModule } from '../promo-codes/promo-codes.module';
import { User } from '../users/entities/user.entity';
import { Subscription } from './entities/subscription.entity';
import { SubscriptionPlanEntity } from './plans/entities/subscription-plan.entity';
import { PlansAdminController } from './plans/plans-admin.controller';
import { PlansPublicController } from './plans/plans-public.controller';
import { PlansService } from './plans/plans.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { EntitlementsAdminController } from './entitlements-admin.controller';
import { EntitlementsAdminService } from './entitlements-admin.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Subscription,
      SubscriptionPlanEntity,
      User,
      AuditLog,
    ]),
    forwardRef(() => PaymentsModule),
    PromoCodesModule,
  ],
  controllers: [
    SubscriptionsController,
    PlansPublicController,
    PlansAdminController,
    EntitlementsAdminController,
  ],
  providers: [SubscriptionsService, PlansService, EntitlementsAdminService],
  exports: [
    SubscriptionsService,
    PlansService,
    EntitlementsAdminService,
    TypeOrmModule,
  ],
})
export class SubscriptionsModule {}
