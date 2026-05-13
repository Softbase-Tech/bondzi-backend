import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { User } from '../users/entities/user.entity';
import { PaymentEvent } from './entities/payment-event.entity';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PAYMENT_PROVIDERS } from './providers/payment-provider.interface';
import { PaymentProviderRegistry } from './providers/payment-provider.registry';
import { PaystackProvider } from './providers/paystack/paystack.provider';
import { WebhookController } from './webhooks/webhook.controller';
import { WebhookHandlerService } from './webhooks/webhook-handler.service';

/**
 * Registering a new provider:
 *   1. Implement PaymentProvider under ./providers/<name>/.
 *   2. Add the class to the providers: array below.
 *   3. Append it to the PAYMENT_PROVIDERS factory's inject + return list.
 * No other file needs to change — the registry resolves by name.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PaymentEvent, Subscription, User]),
    forwardRef(() => SubscriptionsModule),
  ],
  controllers: [PaymentsController, WebhookController],
  providers: [
    PaymentsService,
    WebhookHandlerService,
    PaystackProvider,
    {
      provide: PAYMENT_PROVIDERS,
      useFactory: (paystack: PaystackProvider) => [paystack],
      inject: [PaystackProvider],
    },
    PaymentProviderRegistry,
  ],
  exports: [
    PaymentsService,
    PaymentProviderRegistry,
    WebhookHandlerService,
    PaystackProvider,
  ],
})
export class PaymentsModule {}
