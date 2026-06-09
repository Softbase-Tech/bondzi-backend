import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PaymentsService } from './payments.service';
import { PaymentEvent } from './entities/payment-event.entity';
import { FinancialEvent } from './entities/financial-event.entity';
import { PaymentAttempt } from './entities/payment-attempt.entity';

/**
 * PaymentsService is a thin read-only audit/query layer (ingestion lives
 * in WebhookHandlerService + PaymentAttemptsService). These tests pin
 * the ordering + limit defaults the admin dashboard pages off.
 */

describe('PaymentsService', () => {
  let service: PaymentsService;
  let eventsRepo: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let attemptsRepo: { findAndCount: jest.Mock };

  beforeEach(async () => {
    eventsRepo = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    attemptsRepo = {
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(PaymentEvent), useValue: eventsRepo },
        // listFinancialEvents isn't exercised by these specs but the
        // service constructor injects the repo — pass a noop.
        {
          provide: getRepositoryToken(FinancialEvent),
          useValue: { createQueryBuilder: jest.fn() },
        },
        {
          provide: getRepositoryToken(PaymentAttempt),
          useValue: attemptsRepo,
        },
      ],
    }).compile();
    service = moduleRef.get(PaymentsService);
  });

  it('listEvents defaults to newest-first, 100 rows', async () => {
    await service.listEvents();
    expect(eventsRepo.find).toHaveBeenCalledWith({
      order: { createdAt: 'DESC' },
      take: 100,
    });
  });

  it('listEvents honours an explicit limit', async () => {
    await service.listEvents(25);
    expect(eventsRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 25 }),
    );
  });

  it('listUserPaymentAttempts is scoped to the user, joins plan, orders newest-first, paginates', async () => {
    await service.listUserPaymentAttempts('user-1', { limit: 10, offset: 20 });
    expect(attemptsRepo.findAndCount).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      relations: ['plan'],
      order: { initiatedAt: 'DESC' },
      take: 10,
      skip: 20,
    });
  });

  it('listUserPaymentAttempts clamps limit to a sane range', async () => {
    // 9999 should clamp down to the max (100). Negative offset → 0.
    await service.listUserPaymentAttempts('user-1', {
      limit: 9999,
      offset: -5,
    });
    expect(attemptsRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100, skip: 0 }),
    );
  });
});
