import { Test } from '@nestjs/testing';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

describe('ReferralsController', () => {
  let controller: ReferralsController;
  let referrals: jest.Mocked<ReferralsService>;

  beforeEach(async () => {
    referrals = {
      statsForUser: jest.fn(),
      listEvents: jest.fn(),
    } as unknown as jest.Mocked<ReferralsService>;
    const moduleRef = await Test.createTestingModule({
      controllers: [ReferralsController],
      providers: [{ provide: ReferralsService, useValue: referrals }],
    }).compile();
    controller = moduleRef.get(ReferralsController);
  });

  it('me forwards only the JWT user id', () => {
    controller.me({ id: 'u' } as never);
    expect(referrals.statsForUser).toHaveBeenCalledWith('u');
  });

  it('events forwards only the JWT user id', () => {
    controller.events({ id: 'u' } as never);
    expect(referrals.listEvents).toHaveBeenCalledWith('u');
  });
});
