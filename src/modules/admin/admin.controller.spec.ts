import { Test } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminJobsService } from './admin-jobs.service';
import { AdminNotificationsService } from './admin-notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { PaymentAttemptsService } from '../payments/payment-attempts.service';
import { BillingLogService } from '../payments/billing-log.service';
import { PaymentAttemptStatus } from '../../common/types/enums';

/**
 * AdminController is a wiring layer protected by RolesGuard. Tests cover:
 *  - banUser / resolveFlag forward the admin id + req.ip for the audit log
 *  - failedJobs parses the limit query string and defaults it to 50
 *  - listPayments hard-codes a 200 row cap (the admin dashboard never shows
 *    more than that on a single page)
 */

describe('AdminController', () => {
  let controller: AdminController;
  let admin: jest.Mocked<AdminService>;
  let adminJobs: jest.Mocked<AdminJobsService>;
  let adminNotifications: jest.Mocked<AdminNotificationsService>;
  let payments: jest.Mocked<PaymentsService>;
  let paymentAttempts: jest.Mocked<PaymentAttemptsService>;
  let billingLog: jest.Mocked<BillingLogService>;

  beforeEach(async () => {
    admin = {
      dashboard: jest.fn(),
      listUsers: jest.fn(),
      getUser: jest.fn(),
      banUser: jest.fn(),
      listFlags: jest.fn(),
      resolveFlag: jest.fn(),
      aiUsageBreakdown: jest.fn(),
      listSubscriptions: jest.fn(),
      listAudit: jest.fn(),
    } as unknown as jest.Mocked<AdminService>;
    adminJobs = {
      list: jest.fn(),
      failed: jest.fn(),
    } as unknown as jest.Mocked<AdminJobsService>;
    adminNotifications = {
      broadcast: jest.fn(),
    } as unknown as jest.Mocked<AdminNotificationsService>;
    payments = {
      listEvents: jest.fn(),
    } as unknown as jest.Mocked<PaymentsService>;
    paymentAttempts = {
      listAll: jest.fn(),
    } as unknown as jest.Mocked<PaymentAttemptsService>;
    billingLog = {
      listAll: jest.fn(),
    } as unknown as jest.Mocked<BillingLogService>;

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: admin },
        { provide: AdminJobsService, useValue: adminJobs },
        { provide: AdminNotificationsService, useValue: adminNotifications },
        { provide: PaymentsService, useValue: payments },
        { provide: PaymentAttemptsService, useValue: paymentAttempts },
        { provide: BillingLogService, useValue: billingLog },
      ],
    }).compile();
    controller = moduleRef.get(AdminController);
  });

  it('banUser forwards (adminId, userId, req.ip) so the audit row carries the IP', () => {
    controller.banUser({ id: 'admin-1' } as never, 'user-1', {
      ip: '1.2.3.4',
    } as never);
    expect(admin.banUser).toHaveBeenCalledWith('admin-1', 'user-1', '1.2.3.4');
  });

  it('resolveFlag forwards (adminId, flagId, req.ip)', () => {
    controller.resolveFlag({ id: 'admin-1' } as never, 'flag-1', {
      ip: '1.2.3.4',
    } as never);
    expect(admin.resolveFlag).toHaveBeenCalledWith(
      'admin-1',
      'flag-1',
      '1.2.3.4',
    );
  });

  it('failedJobs parses the limit query string into a number', () => {
    controller.failedJobs('ai-generation', '25');
    expect(adminJobs.failed).toHaveBeenCalledWith('ai-generation', 25);
  });

  it('failedJobs defaults the limit to 50 when the query is missing', () => {
    controller.failedJobs('ai-generation', undefined);
    expect(adminJobs.failed).toHaveBeenCalledWith('ai-generation', 50);
  });

  it('listPayments paginates payment_attempts with sane defaults', () => {
    controller.listPayments();
    expect(paymentAttempts.listAll).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      status: undefined,
    });
  });

  it('listPayments forwards status / limit / offset query params', () => {
    controller.listPayments('25', '50', PaymentAttemptStatus.PAID);
    expect(paymentAttempts.listAll).toHaveBeenCalledWith({
      limit: 25,
      offset: 50,
      status: PaymentAttemptStatus.PAID,
    });
  });

  it('listBillingLog paginates billing_log with sane defaults', () => {
    controller.listBillingLog();
    expect(billingLog.listAll).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      processStatus: undefined,
    });
  });

  it('listPaymentEvents (legacy) hard-codes a 200 row cap', () => {
    controller.listPaymentEvents();
    expect(payments.listEvents).toHaveBeenCalledWith(200);
  });
});
