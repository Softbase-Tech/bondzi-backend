import { Test } from '@nestjs/testing';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

describe('PaymentsController', () => {
  it('GET /payments/me forwards the JWT user id + pagination to the service', async () => {
    const payments = {
      listUserPaymentAttempts: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0 }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [{ provide: PaymentsService, useValue: payments }],
    }).compile();
    const controller = moduleRef.get(PaymentsController);
    await controller.history({ id: 'user-1' } as never, 25, 0);
    expect(payments.listUserPaymentAttempts).toHaveBeenCalledWith('user-1', {
      limit: 25,
      offset: 0,
    });
  });
});
