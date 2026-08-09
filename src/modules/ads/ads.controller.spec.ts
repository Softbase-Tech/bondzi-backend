import { Test } from '@nestjs/testing';
import { AdsController } from './ads.controller';
import { AdsService } from './ads.service';

describe('AdsController', () => {
  let controller: AdsController;
  let ads: jest.Mocked<AdsService>;

  beforeEach(async () => {
    ads = {
      getClientConfig: jest.fn(),
      awardRewarded: jest.fn(),
      getAdminConfig: jest.fn(),
      updateAdminConfig: jest.fn(),
    } as unknown as jest.Mocked<AdsService>;
    const moduleRef = await Test.createTestingModule({
      controllers: [AdsController],
      providers: [{ provide: AdsService, useValue: ads }],
    }).compile();
    controller = moduleRef.get(AdsController);
  });

  it('GET /ads/config forwards the JWT user id and examType', () => {
    controller.clientConfig({ id: 'u', examType: 'wassce' } as never);
    expect(ads.getClientConfig).toHaveBeenCalledWith('u', 'wassce');
  });

  it('POST /ads/rewarded-complete forwards the JWT user id and examType', () => {
    controller.rewardedComplete({ id: 'u', examType: 'wassce' } as never);
    expect(ads.awardRewarded).toHaveBeenCalledWith('u', 'wassce');
  });

  it('PATCH /admin/ads/config forwards the body to the service', () => {
    controller.updateAdminConfig({ adsEnabled: false } as never);
    expect(ads.updateAdminConfig).toHaveBeenCalledWith({ adsEnabled: false });
  });
});
