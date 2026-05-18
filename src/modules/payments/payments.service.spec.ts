import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PaymentsService } from './payments.service';
import { PaymentEvent } from './entities/payment-event.entity';
import { FinancialEvent } from './entities/financial-event.entity';

/**
 * PaymentsService is now a thin read-only audit query layer (ingestion moved
 * to WebhookHandlerService). These tests pin the ordering + limit defaults
 * because the admin dashboard pages off them.
 */

describe('PaymentsService', () => {
  let service: PaymentsService;
  let eventsRepo: { find: jest.Mock; createQueryBuilder: jest.Mock };

  beforeEach(async () => {
    eventsRepo = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
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

  it('listUserPayments filters by indexed user_id column (with JSONB fallback for legacy rows)', async () => {
    // Previously the only path was `raw_payload -> ... -> userId`, which
    // was a JSONB seq-scan over every webhook ever received. The new
    // shape queries the denormalised `user_id` column primarily and
    // falls back to the JSONB path only for legacy rows where the
    // webhook handler couldn't resolve a user at insert time.
    const qb = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    eventsRepo.createQueryBuilder.mockReturnValueOnce(qb);
    await service.listUserPayments('user-1');
    expect(qb.where).toHaveBeenCalledWith('e.user_id = :userId', {
      userId: 'user-1',
    });
    expect(qb.orWhere).toHaveBeenCalledWith(
      expect.stringContaining("metadata' ->> 'userId'"),
      { userId: 'user-1' },
    );
    expect(qb.orderBy).toHaveBeenCalledWith('e.created_at', 'DESC');
  });
});
