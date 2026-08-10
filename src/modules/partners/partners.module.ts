import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { DeviceSession } from '../auth/entities/device-session.entity';
import { User } from '../users/entities/user.entity';
import { PartnerAppeal } from './entities/partner-appeal.entity';
import { PartnerAttribution } from './entities/partner-attribution.entity';
import { PartnerCommission } from './entities/partner-commission.entity';
import { PartnerFraudEvent } from './entities/partner-fraud-event.entity';
import { PartnerPayout } from './entities/partner-payout.entity';
import { PartnerReferralCode } from './entities/partner-referral-code.entity';
import { PartnerSignupCredit } from './entities/partner-signup-credit.entity';
import { PartnerTermsVersion } from './entities/partner-terms-version.entity';
import { Partner } from './entities/partner.entity';
import { PartnerAttributionsService } from './partner-attributions.service';
import { PartnerAuthGuard } from './partner-auth.guard';
import { PartnerTermsService } from './partner-terms.service';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';

/**
 * Foundation module for the partner portal. Exposes:
 *
 *   - PartnersService              (partner + code lifecycle)
 *   - PartnerAttributionsService   (register-time attribution + fraud)
 *   - PartnerTermsService          (versioned commission-terms doc)
 *   - PartnerAuthGuard             (route protection)
 *
 * Consumed by AuthModule (register hook → attribution) via
 * `forwardRef` because AuthModule also imports parts of this
 * subgraph. Commissions, payouts, admin surfaces, and appeals are
 * layered on in Phases 2–5.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Partner,
      PartnerReferralCode,
      PartnerAttribution,
      PartnerTermsVersion,
      PartnerSignupCredit,
      PartnerCommission,
      PartnerPayout,
      PartnerFraudEvent,
      PartnerAppeal,
      DeviceSession,
      User,
    ]),
    forwardRef(() => AuthModule),
  ],
  controllers: [PartnersController],
  providers: [
    PartnersService,
    PartnerAttributionsService,
    PartnerTermsService,
    PartnerAuthGuard,
  ],
  exports: [
    PartnersService,
    PartnerAttributionsService,
    PartnerTermsService,
    PartnerAuthGuard,
    TypeOrmModule,
  ],
})
export class PartnersModule {}
