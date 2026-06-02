import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PromoCode } from './entities/promo-code.entity';
import { PromoRedemption } from './entities/promo-redemption.entity';
import { PromoCodesController } from './promo-codes.controller';
import { PromoCodesService } from './promo-codes.service';

@Module({
  imports: [TypeOrmModule.forFeature([PromoCode, PromoRedemption])],
  controllers: [PromoCodesController],
  providers: [PromoCodesService],
  // Exported so SubscriptionsService.initiate can call `quote()` /
  // `recordRedemption()` when promo codes are applied at checkout.
  exports: [PromoCodesService],
})
export class PromoCodesModule {}
