import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserAwareThrottlerGuard } from './common/guards/user-aware-throttler.guard';

import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import redisConfig from './config/redis.config';
import jwtConfig from './config/jwt.config';
import aiConfig from './config/ai.config';
import paystackConfig from './config/paystack.config';
import storageConfig from './config/storage.config';
import smsConfig from './config/sms.config';
import mailConfig from './config/mail.config';
import firebaseConfig from './config/firebase.config';
import throttleConfig from './config/throttle.config';
import observabilityConfig from './config/observability.config';
import { envValidationSchema } from './config/validation.schema';

import { DatabaseModule } from './database/database.module';
import { RedisModule } from './common/redis/redis.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { SubscriptionGuard } from './common/guards/subscription.guard';
import { RequestContextModule } from './common/observability/request-context';
import { PinoLoggerModule } from './common/observability/logger.module';
import { ObservabilityModule } from './common/observability/observability.module';

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { SubjectsModule } from './modules/subjects/subjects.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { ExamsModule } from './modules/exams/exams.module';
import { SrsModule } from './modules/srs/srs.module';
import { AiModule } from './modules/ai/ai.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { SchoolsModule } from './modules/schools/schools.module';
import { LeaderboardModule } from './modules/leaderboard/leaderboard.module';
import { ProgressModule } from './modules/progress/progress.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AdminModule } from './modules/admin/admin.module';
import { EntitlementsModule } from './modules/entitlements/entitlements.module';
import { RequiresServiceGuard } from './modules/entitlements/requires-service.guard';
import { HealthModule } from './modules/health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { Subscription } from './modules/subscriptions/entities/subscription.entity';
import { TypeOrmModule } from '@nestjs/typeorm';

// v2 modules
import { XpEconomyModule } from './modules/xp-economy/xp-economy.module';
import { GamificationModule } from './modules/gamification/gamification.module';
import { ReferralsModule } from './modules/referrals/referrals.module';
import { PmTestModule } from './modules/pm-test/pm-test.module';
import { AdminAiGenModule } from './modules/admin-ai-gen/admin-ai-gen.module';
import { AdsModule } from './modules/ads/ads.module';
import { MailModule } from './modules/mail/mail.module';
import { LegalModule } from './modules/legal/legal.module';
import { AccountDeletionsModule } from './modules/account-deletions/account-deletions.module';
import { PromoCodesModule } from './modules/promo-codes/promo-codes.module';
import { PartnersModule } from './modules/partners/partners.module';
import { SupportModule } from './modules/support/support.module';
import { AchievementsModule } from './modules/achievements/achievements.module';
import { FaqModule } from './modules/faq/faq.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
      load: [
        appConfig,
        databaseConfig,
        redisConfig,
        jwtConfig,
        aiConfig,
        paystackConfig,
        storageConfig,
        smsConfig,
        mailConfig,
        firebaseConfig,
        throttleConfig,
        observabilityConfig,
      ],
    }),

    // RequestContextModule must come BEFORE PinoLoggerModule — the
    // pino mixin reads requestId from CLS, which only works if the
    // CLS middleware has already run.
    RequestContextModule,
    PinoLoggerModule,
    ObservabilityModule,

    ScheduleModule.forRoot(),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => [
        {
          name: 'short',
          ttl: cfg.get<number>('throttle.shortTtl')! * 1000,
          limit: cfg.get<number>('throttle.shortLimit')!,
        },
        {
          name: 'long',
          ttl: cfg.get<number>('throttle.longTtl')! * 1000,
          limit: cfg.get<number>('throttle.longLimit')!,
        },
      ],
    }),

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const url = new URL(cfg.get<string>('redis.url') as string);
        return {
          connection: {
            host: url.hostname,
            port: parseInt(url.port || '6379', 10),
            username: url.username || undefined,
            password: url.password || undefined,
            tls: cfg.get<boolean>('redis.tls') ? {} : undefined,
          },
        };
      },
    }),

    DatabaseModule,
    RedisModule,

    // SubscriptionGuard needs Subscription repository.
    TypeOrmModule.forFeature([Subscription]),

    AuthModule,
    UsersModule,
    SubjectsModule,
    QuestionsModule,
    ExamsModule,
    SrsModule,
    AiModule,
    SubscriptionsModule,
    PaymentsModule,
    SchoolsModule,
    LeaderboardModule,
    ProgressModule,
    NotificationsModule,
    AdminModule,
    HealthModule,
    JobsModule,

    // v2 new modules
    XpEconomyModule,
    GamificationModule,
    ReferralsModule,
    PmTestModule,
    AdminAiGenModule,
    AdsModule,
    MailModule,
    LegalModule,
    AccountDeletionsModule,
    SupportModule,
    AchievementsModule,
    FaqModule,
    PromoCodesModule,
    PartnersModule,
    EntitlementsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    // pino-http (registered by PinoLoggerModule) replaces the old
    // LoggingInterceptor — one source of truth for per-request logs.
    // UserAwareThrottlerGuard prefers `req.user.id` over IP for the
    // throttle key — so shared-NAT (school WiFi, mobile gateway)
    // students don't collide into one bucket on per-user rate limits
    // (e.g. PATCH /auth/me/exam-type, password change).
    { provide: APP_GUARD, useClass: UserAwareThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: SubscriptionGuard },
    // MUST come after JwtAuthGuard so req.user is populated when this
    // guard reads it. NestJS executes APP_GUARDs in the order they're
    // listed in this providers array.
    { provide: APP_GUARD, useClass: RequiresServiceGuard },
  ],
})
export class AppModule {}
