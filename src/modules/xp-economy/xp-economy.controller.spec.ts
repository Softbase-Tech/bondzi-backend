import { Test } from '@nestjs/testing';
import { XpEconomyController } from './xp-economy.controller';
import { XpEconomyService } from './xp-economy.service';

describe('XpEconomyController', () => {
  let controller: XpEconomyController;
  let xp: jest.Mocked<XpEconomyService>;

  beforeEach(async () => {
    xp = {
      summary: jest.fn(),
      listTiers: jest.fn(),
      listRates: jest.fn(),
      history: jest.fn(),
      redeem: jest.fn(),
    } as unknown as jest.Mocked<XpEconomyService>;
    const moduleRef = await Test.createTestingModule({
      controllers: [XpEconomyController],
      providers: [{ provide: XpEconomyService, useValue: xp }],
    }).compile();
    controller = moduleRef.get(XpEconomyController);
  });

  it('history parses the limit query string', () => {
    controller.history({ id: 'u' } as never, '25');
    expect(xp.history).toHaveBeenCalledWith('u', 25);
  });

  it('history defaults limit to 50 when the query is missing', () => {
    controller.history({ id: 'u' } as never);
    expect(xp.history).toHaveBeenCalledWith('u', 50);
  });

  it('history falls back to 50 when the parsed limit is NaN', () => {
    controller.history({ id: 'u' } as never, 'abc');
    expect(xp.history).toHaveBeenCalledWith('u', 50);
  });

  it('redeem forwards (userId, tierKey)', () => {
    controller.redeem({ id: 'u' } as never, { tierKey: 't-30' } as never);
    expect(xp.redeem).toHaveBeenCalledWith('u', 't-30');
  });
});
