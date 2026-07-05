import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TierService } from './entities/tier-service.entity';
import { UserServiceUsage } from './entities/user-service-usage.entity';
import { User } from '../users/entities/user.entity';
import { EntitlementsService } from './entitlements.service';
import { RequiresServiceGuard } from './requires-service.guard';
import { AdminEntitlementsController } from './admin-entitlements.controller';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

/**
 * Provides the entitlements matrix service, the `@RequiresService`
 * guard (registered as APP_GUARD by app.module.ts so it runs AFTER
 * JwtAuthGuard, which is what populates req.user), the admin CRUD
 * surface, and the two TypeORM entities. Reads subscription tiers via
 * SubscriptionsModule.
 *
 * The guard is intentionally NOT wired here — ordering across
 * modules for global guards is fragile, so app.module.ts owns the
 * APP_GUARD ordering explicitly and just imports this module for the
 * class + its dependency graph.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TierService, UserServiceUsage, User]),
    SubscriptionsModule,
  ],
  controllers: [AdminEntitlementsController],
  providers: [EntitlementsService, RequiresServiceGuard],
  exports: [EntitlementsService, RequiresServiceGuard],
})
export class EntitlementsModule {}
