import { Test } from '@nestjs/testing';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

describe('PaymentsController', () => {
  it('GET /payments/history forwards the JWT user id to the service', async () => {
    const payments = { listUserPayments: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [{ provide: PaymentsService, useValue: payments }],
    }).compile();
    const controller = moduleRef.get(PaymentsController);
    await controller.history({ id: 'user-1' } as never);
    expect(payments.listUserPayments).toHaveBeenCalledWith('user-1');
  });
});
