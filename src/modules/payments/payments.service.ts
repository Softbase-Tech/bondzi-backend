import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaymentEvent } from './entities/payment-event.entity';

/**
 * Historical/audit queries over payment_events. Webhook ingestion has moved
 * to WebhookHandlerService (per-provider normalized events).
 */
@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(PaymentEvent)
    private readonly eventsRepo: Repository<PaymentEvent>,
  ) {}

  async listEvents(limit = 100): Promise<PaymentEvent[]> {
    return this.eventsRepo.find({ order: { createdAt: 'DESC' }, take: limit });
  }

  async listUserPayments(userId: string): Promise<PaymentEvent[]> {
    return this.eventsRepo
      .createQueryBuilder('e')
      .where(`e.raw_payload -> 'data' -> 'metadata' ->> 'userId' = :userId`, {
        userId,
      })
      .orderBy('e.created_at', 'DESC')
      .getMany();
  }
}
