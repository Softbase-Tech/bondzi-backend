import { Test } from '@nestjs/testing';
import { PlansAdminController } from './plans-admin.controller';
import { PlansService } from './plans.service';

describe('PlansAdminController', () => {
  let controller: PlansAdminController;
  let plans: jest.Mocked<PlansService>;

  beforeEach(async () => {
    plans = {
      list: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      syncWithProvider: jest.fn(),
      setDefault: jest.fn(),
      rollbackTo: jest.fn(),
    } as unknown as jest.Mocked<PlansService>;
    const moduleRef = await Test.createTestingModule({
      controllers: [PlansAdminController],
      providers: [{ provide: PlansService, useValue: plans }],
    }).compile();
    controller = moduleRef.get(PlansAdminController);
  });

  it('list defaults includeInactive to true (admins see archived plans)', () => {
    controller.list('GH');
    expect(plans.list).toHaveBeenCalledWith({
      countryCode: 'GH',
      includeInactive: true,
    });
  });

  it('list parses ?includeInactive=false into a boolean false', () => {
    controller.list('GH', 'false');
    expect(plans.list).toHaveBeenCalledWith({
      countryCode: 'GH',
      includeInactive: false,
    });
  });

  it('create forwards (adminId, dto) so the audit row carries triggeredBy', () => {
    controller.create({ id: 'admin-1' } as never, { name: 'X' } as never);
    expect(plans.create).toHaveBeenCalledWith('admin-1', { name: 'X' });
  });

  it('rollback forwards (adminId, archivedId) — only the archive row pointer', () => {
    controller.rollback({ id: 'admin-1' } as never, 'plan-archived');
    expect(plans.rollbackTo).toHaveBeenCalledWith('admin-1', 'plan-archived');
  });
});
