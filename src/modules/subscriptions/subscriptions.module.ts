import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../admin/entities/audit-log.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { PartnersModule } from '../partners/partners.module';
import { PaymentsModule } from '../payments/payments.module';
import { PromoCodesModule } from '../promo-codes/promo-codes.module';
import { User } from '../users/entities/user.entity';
import { Subject } from '../subjects/entities/subject.entity';
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
      Subject,
    ]),
    forwardRef(() => PaymentsModule),
    PromoCodesModule,
    // EntitlementsAdminService notifies users on manual grant.
    NotificationsModule,
    // Partner commission engine — Stream A hooks Plus activation
    // inside consumePaidAttempt; clawback fires from applyRefund.
    // PartnersModule doesn't import SubscriptionsModule (only the
    // Subscription entity via TypeOrmModule.forFeature) so no cycle.
    PartnersModule,
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
