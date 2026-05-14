import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PaymentsService } from './payments.service';
import { PaymentEvent } from './entities/payment-event.entity';

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

  it('listUserPayments filters by metadata userId via raw jsonb path', async () => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    eventsRepo.createQueryBuilder.mockReturnValueOnce(qb);
    await service.listUserPayments('user-1');
    expect(qb.where).toHaveBeenCalledWith(
      expect.stringContaining("metadata' ->> 'userId'"),
      { userId: 'user-1' },
    );
    expect(qb.orderBy).toHaveBeenCalledWith('e.created_at', 'DESC');
  });
});
