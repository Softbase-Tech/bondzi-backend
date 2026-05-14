import { Test } from '@nestjs/testing';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { BillingInterval } from '../../common/types/enums';

describe('SubscriptionsController', () => {
  let controller: SubscriptionsController;
  let subs: jest.Mocked<SubscriptionsService>;

  beforeEach(async () => {
    subs = {
      getMine: jest.fn(),
      initiate: jest.fn(),
      verify: jest.fn(),
      cancel: jest.fn(),
    } as unknown as jest.Mocked<SubscriptionsService>;

    const moduleRef = await Test.createTestingModule({
      controllers: [SubscriptionsController],
      providers: [{ provide: SubscriptionsService, useValue: subs }],
    }).compile();
    controller = moduleRef.get(SubscriptionsController);
  });

  it('GET /subscriptions/me forwards the user id', () => {
    controller.me({ id: 'user-1' } as never);
    expect(subs.getMine).toHaveBeenCalledWith('user-1');
  });

  it('POST /subscriptions/initiate forwards user id + planId + interval', () => {
    controller.initiate(
      { id: 'user-1' } as never,
      { planId: 'plan-1', interval: BillingInterval.MONTHLY } as never,
    );
    expect(subs.initiate).toHaveBeenCalledWith(
      'user-1',
      'plan-1',
      BillingInterval.MONTHLY,
    );
  });

  it('POST /subscriptions/verify forwards user id + reference', () => {
    controller.verify(
      { id: 'user-1' } as never,
      { reference: 'ref_1' } as never,
    );
    expect(subs.verify).toHaveBeenCalledWith('user-1', 'ref_1');
  });

  it('POST /subscriptions/cancel forwards the user id', () => {
    controller.cancel({ id: 'user-1' } as never);
    expect(subs.cancel).toHaveBeenCalledWith('user-1');
  });
});
