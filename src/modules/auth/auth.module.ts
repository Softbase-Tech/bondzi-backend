import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { DeviceSession } from './entities/device-session.entity';
import { ReferralEvent } from '../referrals/entities/referral-event.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokensService } from './tokens.service';
import { OtpService } from './otp.service';
import { AfricasTalkingSmsProvider } from './sms.service';
import { GoogleOAuthService } from './google-oauth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { ReferralsModule } from '../referrals/referrals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Subscription,
      DeviceSession,
      ReferralEvent,
    ]),
    ReferralsModule,
    NotificationsModule,
    // TokensService injects SubscriptionsService to resolve the user's
    // current-level entitlement at JWT-issue time (the `subscriptionStatus`
    // claim mirrors their account on the level baked into the token).
    // Without this import the DI container can't resolve TokensService,
    // which boot-fails the entire backend.
    SubscriptionsModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret') as string,
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokensService,
    OtpService,
    AfricasTalkingSmsProvider,
    GoogleOAuthService,
    JwtStrategy,
  ],
  exports: [AuthService, TokensService, JwtStrategy],
})
export class AuthModule {}
