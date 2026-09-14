import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ReportDeliveryService } from './report-delivery.service';
import { ReportDelivery } from '../entities/report-delivery.entity';
import { MailService } from '../../mail/mail.service';
import { MailEvent } from '../../mail/mail.types';

const RANGE = { start: '2026-09-10', end: '2026-09-10' };
const RENDERED = { subject: 'S', text: 'T', html: '<p>H</p>' };

describe('ReportDeliveryService', () => {
  let repo: Record<string, jest.Mock>;
  let mail: { send: jest.Mock };
  let svc: ReportDeliveryService;

  async function build(existing: Partial<ReportDelivery> | null = null) {
    const qb: Record<string, unknown> = {};
    const chain = () => () => qb;
    qb.insert = chain();
    qb.into = chain();
    qb.values = chain();
    qb.orUpdate = chain();
    qb.execute = jest.fn().mockResolvedValue({});
    repo = {
      findOne: jest.fn().mockResolvedValue(existing),
      createQueryBuilder: jest.fn(() => qb),
      increment: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockResolvedValue([]),
    };
    mail = { send: jest.fn().mockResolvedValue(undefined) };
    const m = await Test.createTestingModule({
      providers: [
        ReportDeliveryService,
        { provide: getRepositoryToken(ReportDelivery), useValue: repo },
        { provide: MailService, useValue: mail },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => ['founder@bondzi.online']) },
        },
      ],
    }).compile();
    svc = m.get(ReportDeliveryService);
    return svc;
  }

  describe('claim', () => {
    it('refuses a period already sent', async () => {
      await build({ status: 'sent', attemptCount: 1 } as ReportDelivery);
      const c = await svc.claim('daily', RANGE, ['a@b.co']);
      expect(c.alreadySent).toBe(true);
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('leaves a fresh in-flight claim alone', async () => {
      await build({
        status: 'sending',
        claimedAt: new Date(),
        attemptCount: 1,
      } as ReportDelivery);
      // Another runner is probably mid-send; stealing it risks two emails.
      expect((await svc.claim('daily', RANGE, ['a@b.co'])).alreadySent).toBe(
        true,
      );
    });

    it('takes over a STALE sending row — a crashed run must not wedge the period', async () => {
      await build({
        status: 'sending',
        claimedAt: new Date(Date.now() - 60 * 60 * 1000),
        attemptCount: 1,
      } as ReportDelivery);
      const c = await svc.claim('daily', RANGE, ['a@b.co']);
      expect(c.alreadySent).toBe(false);
      expect(repo.increment).toHaveBeenCalled();
    });

    it('retries a failed period in place rather than blocking it forever', async () => {
      // The bug the old ledger design had: a failed row behind a hard
      // UNIQUE meant 'sent' could never be recorded for that period.
      await build({ status: 'failed', attemptCount: 2 } as ReportDelivery);
      const c = await svc.claim('daily', RANGE, ['a@b.co']);
      expect(c.alreadySent).toBe(false);
      expect(c.attempt).toBe(3);
    });

    it('re-sends an already-sent period when forced', async () => {
      await build({ status: 'sent', attemptCount: 1 } as ReportDelivery);
      expect(
        (await svc.claim('daily', RANGE, ['a@b.co'], true)).alreadySent,
      ).toBe(false);
    });
  });

  describe('send', () => {
    it('uses a per-recipient dedup key so a partial failure retries only the gap', async () => {
      await build();
      await svc.send('daily', RANGE, ['a@b.co', 'c@d.co'], RENDERED);
      expect(mail.send).toHaveBeenCalledTimes(2);
      const keys = mail.send.mock.calls.map((c) => c[3].dedupKey);
      expect(keys).toEqual([
        'report:daily:2026-09-10:a@b.co',
        'report:daily:2026-09-10:c@d.co',
      ]);
      // Distinct keys are what make "one of two recipients failed"
      // recoverable without re-mailing the one who already got it.
      expect(new Set(keys).size).toBe(2);
    });

    it('sends the pre-rendered parts through the OPS_REPORT event', async () => {
      await build();
      await svc.send('daily', RANGE, ['a@b.co'], RENDERED);
      const [event, to, payload, opts] = mail.send.mock.calls[0];
      expect(event).toBe(MailEvent.OPS_REPORT);
      expect(to).toBe('a@b.co');
      expect(payload).toEqual({ subject: 'S', html: '<p>H</p>', text: 'T' });
      // Synchronous: a morning when the queue is the broken thing is
      // exactly when the report must not be queued behind it.
      expect(opts.sync).toBe(true);
    });

    it('varies the dedup key on a forced re-send, or MailService would refuse it', async () => {
      await build();
      await svc.send('daily', RANGE, ['a@b.co'], RENDERED, true);
      expect(mail.send.mock.calls[0][3].dedupKey).toMatch(
        /^report:daily:2026-09-10:a@b\.co:force:\d+$/,
      );
    });
  });

  describe('outcome recording', () => {
    it('clears the error when a retry finally succeeds', async () => {
      await build();
      await svc.markSent('daily', RANGE);
      expect(repo.update).toHaveBeenCalledWith(
        { reportType: 'daily', periodStart: '2026-09-10' },
        expect.objectContaining({ status: 'sent', error: null }),
      );
    });

    it('truncates a huge error rather than bloating the ledger', async () => {
      await build();
      await svc.markFailed('daily', RANGE, 'x'.repeat(5000));
      const patch = repo.update.mock.calls[0][1] as { error: string };
      expect(patch.error.length).toBe(1000);
    });
  });
});
