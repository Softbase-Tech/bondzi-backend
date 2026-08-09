import { Test } from '@nestjs/testing';
import { AdminReferralsController } from './admin-referrals.controller';
import { ReferralsService } from './referrals.service';

describe('AdminReferralsController', () => {
  let controller: AdminReferralsController;
  let referrals: {
    adminMetrics: jest.Mock;
    adminTopReferrers: jest.Mock;
    adminChain: jest.Mock;
    getShareTemplate: jest.Mock;
    setShareTemplate: jest.Mock;
  };

  beforeEach(async () => {
    referrals = {
      adminMetrics: jest.fn(),
      adminTopReferrers: jest.fn(),
      adminChain: jest.fn(),
      getShareTemplate: jest.fn(),
      setShareTemplate: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminReferralsController],
      providers: [{ provide: ReferralsService, useValue: referrals }],
    }).compile();
    controller = moduleRef.get(AdminReferralsController);
  });

  it('top clamps the limit query to [1, 200] and defaults to 50', () => {
    controller.top();
    expect(referrals.adminTopReferrers).toHaveBeenCalledWith(50);
    controller.top('500');
    expect(referrals.adminTopReferrers).toHaveBeenLastCalledWith(200);
    controller.top('-5');
    expect(referrals.adminTopReferrers).toHaveBeenLastCalledWith(1);
  });

  it('chain tolerates a missing query param (sends empty string)', () => {
    controller.chain(undefined as unknown as string);
    expect(referrals.adminChain).toHaveBeenCalledWith('');
  });

  it('setShareTemplate tolerates a missing template field', () => {
    controller.setShareTemplate(undefined as never);
    expect(referrals.setShareTemplate).toHaveBeenCalledWith('');
  });
});
