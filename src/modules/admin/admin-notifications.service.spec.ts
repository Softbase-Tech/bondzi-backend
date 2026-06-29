import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminNotificationsService } from './admin-notifications.service';
import { User } from '../users/entities/user.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BroadcastSegment } from './dto/broadcast-notification.dto';
import { NotificationChannel } from '../../common/types/enums';

/**
 *  - broadcast fans out one Notification per (user, channel) combination.
 *  - resolveSegment routes each segment to the right query; FREE = ALL minus
 *    PAID (set difference).
 *  - A throw from notifications.send for one user must not abort the loop —
 *    one bad device shouldn't drop the whole broadcast.
 */

describe('AdminNotificationsService', () => {
  let service: AdminNotificationsService;
  let usersRepo: { createQueryBuilder: jest.Mock };
  let subsRepo: { createQueryBuilder: jest.Mock };
  let notifications: { send: jest.Mock };

  function stubUsersQb(rows: Array<{ id: string }>) {
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    };
    usersRepo.createQueryBuilder.mockReturnValueOnce(qb);
    return qb;
  }
  function stubSubsQb(rows: Array<{ id: string }>) {
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    };
    subsRepo.createQueryBuilder.mockReturnValueOnce(qb);
    return qb;
  }

  beforeEach(async () => {
    usersRepo = { createQueryBuilder: jest.fn() };
    subsRepo = { createQueryBuilder: jest.fn() };
    notifications = { send: jest.fn().mockResolvedValue(undefined) };

    const { Notification } =
      await import('../notifications/entities/notification.entity');
    const notificationsRepo = {
      createQueryBuilder: jest.fn(() => ({
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminNotificationsService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(Subscription), useValue: subsRepo },
        {
          provide: getRepositoryToken(Notification),
          useValue: notificationsRepo,
        },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = moduleRef.get(AdminNotificationsService);
  });

  it('fans out one Notification per (user, channel) for an ALL broadcast', async () => {
    stubUsersQb([{ id: 'u1' }, { id: 'u2' }]);
    const out = await service.broadcast({
      segment: BroadcastSegment.ALL,
      channels: [NotificationChannel.PUSH, NotificationChannel.IN_APP],
      title: 't',
      body: 'b',
    });
    expect(notifications.send).toHaveBeenCalledTimes(4); // 2 users * 2 channels
    expect(out.queued).toBe(4);
  });

  it('FREE = ALL minus PAID (set difference)', async () => {
    // PAID first (subsRepo qb)
    stubSubsQb([{ id: 'u2' }]);
    // Then ALL (usersRepo qb)
    stubUsersQb([{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }]);
    await service.broadcast({
      segment: BroadcastSegment.FREE,
      channels: [NotificationChannel.PUSH],
      title: 't',
      body: 'b',
    });
    const targetedIds = notifications.send.mock.calls.map(
      (c) => (c[0] as { userId: string }).userId,
    );
    expect(targetedIds.sort()).toEqual(['u1', 'u3']);
  });

  it('a thrown send for one user does NOT abort the rest of the broadcast', async () => {
    stubUsersQb([{ id: 'u1' }, { id: 'u2' }]);
    notifications.send
      .mockRejectedValueOnce(new Error('FCM down'))
      .mockResolvedValueOnce(undefined);
    const out = await service.broadcast({
      segment: BroadcastSegment.ALL,
      channels: [NotificationChannel.PUSH],
      title: 't',
      body: 'b',
    });
    // Both sends were attempted; only one succeeded.
    expect(notifications.send).toHaveBeenCalledTimes(2);
    expect(out.queued).toBe(1);
  });

  it('CUSTOM segment falls through to active users', async () => {
    stubUsersQb([{ id: 'u1' }]);
    await service.broadcast({
      segment: BroadcastSegment.CUSTOM,
      channels: [NotificationChannel.PUSH],
      title: 't',
      body: 'b',
      region: 'GA',
    } as never);
    // andWhere was called for the region filter
    const lastUsersCall = (
      usersRepo.createQueryBuilder.mock.results[0].value as {
        andWhere: jest.Mock;
      }
    ).andWhere.mock.calls.map((c) => c[0]);
    expect(lastUsersCall).toEqual(
      expect.arrayContaining([expect.stringContaining('region')]),
    );
  });
});
