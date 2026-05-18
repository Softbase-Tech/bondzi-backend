import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationsService } from './notifications.service';
import { Notification } from './entities/notification.entity';
import { DevicePlatform, UserDevice } from './entities/user-device.entity';
import { NotificationChannel } from '../../common/types/enums';
import { QUEUE_NOTIFICATIONS } from '../ai/ai.queues';

/**
 * Coverage:
 *  - send() persists a row and enqueues a dispatch job; queue failures are
 *    swallowed (the row is still saved so retry can re-enqueue later).
 *  - markRead scopes the update by both id AND user (no cross-user reads).
 *  - registerPushToken upserts by (userId, fcmToken).
 *  - tokensForUser / pruneInvalidTokens behaviour.
 */

describe('NotificationsService', () => {
  let service: NotificationsService;
  let notificationsRepo: {
    find: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let devicesRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
    find: jest.Mock;
    delete: jest.Mock;
  };
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    notificationsRepo = {
      find: jest.fn(),
      update: jest.fn(),
      create: jest.fn((o) => ({ id: 'n-1', ...o })),
      save: jest.fn(async (o) => o),
    };
    devicesRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      insert: jest.fn(),
      find: jest.fn(),
      delete: jest.fn(),
    };
    queue = { add: jest.fn(async () => undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: getRepositoryToken(Notification),
          useValue: notificationsRepo,
        },
        { provide: getRepositoryToken(UserDevice), useValue: devicesRepo },
        { provide: getQueueToken(QUEUE_NOTIFICATIONS), useValue: queue },
      ],
    }).compile();
    service = moduleRef.get(NotificationsService);
  });

  // ------------------------------ listForUser ------------------------------

  it('listForUser fetches the user inbox sorted by newest first', async () => {
    notificationsRepo.find.mockResolvedValueOnce([]);
    await service.listForUser('user-1');
    expect(notificationsRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        order: { createdAt: 'DESC' },
      }),
    );
  });

  // ------------------------------ markRead ------------------------------

  it('markRead scopes by both notification id and user (no cross-user mutations)', async () => {
    await service.markRead('user-1', 'notif-9');
    expect(notificationsRepo.update).toHaveBeenCalledWith(
      { id: 'notif-9', userId: 'user-1' },
      { isRead: true },
    );
  });

  // -------------------------------- send --------------------------------

  describe('send', () => {
    it('persists a notification row and enqueues a dispatch job', async () => {
      await service.send({
        userId: 'user-1',
        channel: NotificationChannel.PUSH,
        title: 'Hi',
        body: 'There',
      });
      expect(notificationsRepo.save).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        'dispatch',
        expect.objectContaining({
          notificationId: 'n-1',
          channel: NotificationChannel.PUSH,
        }),
        expect.objectContaining({ attempts: 3 }),
      );
    });

    it('rethrows queue.add failures so callers see the silent-drop instead of swallowing', async () => {
      // The previous shape swallowed the enqueue error and returned the
      // row id as if everything was fine — a Redis blip silently dropped
      // thousands of pushes. We now persist the row, then THROW so the
      // caller (gamification, auth, etc.) can decide whether to retry or
      // wrap in its own try/catch; existing call sites already use
      // `.catch(() => void 0)` for best-effort sends.
      queue.add.mockRejectedValueOnce(new Error('redis down'));
      await expect(
        service.send({
          userId: 'user-1',
          channel: NotificationChannel.PUSH,
          title: 't',
          body: 'b',
        }),
      ).rejects.toThrow('redis down');
      // Row is still persisted (audit trail) — the dispatcher cron can
      // pick it up later.
      expect(notificationsRepo.save).toHaveBeenCalled();
    });
  });

  // --------------------------- registerPushToken ---------------------------

  describe('registerPushToken', () => {
    it('updates an existing row and stamps lastSeenAt', async () => {
      const existing = {
        platform: DevicePlatform.IOS,
        lastSeenAt: new Date(0),
      };
      devicesRepo.findOne.mockResolvedValueOnce(existing);
      await service.registerPushToken({
        userId: 'user-1',
        platform: DevicePlatform.ANDROID,
        fcmToken: 'tok-1',
      });
      expect(devicesRepo.save).toHaveBeenCalledWith(existing);
      expect(existing.platform).toBe(DevicePlatform.ANDROID);
      expect(existing.lastSeenAt.getTime()).toBeGreaterThan(0);
      expect(devicesRepo.insert).not.toHaveBeenCalled();
    });

    it('inserts a new row when no token exists for the user', async () => {
      devicesRepo.findOne.mockResolvedValueOnce(null);
      await service.registerPushToken({
        userId: 'user-1',
        platform: DevicePlatform.IOS,
        fcmToken: 'tok-1',
      });
      expect(devicesRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          fcmToken: 'tok-1',
          platform: DevicePlatform.IOS,
        }),
      );
    });
  });

  // ----------------------- tokensForUser / pruneInvalid -----------------------

  it('tokensForUser returns just the FCM tokens', async () => {
    devicesRepo.find.mockResolvedValueOnce([
      { fcmToken: 'a' },
      { fcmToken: 'b' },
    ]);
    expect(await service.tokensForUser('user-1')).toEqual(['a', 'b']);
  });

  it('pruneInvalidTokens is a no-op when given an empty list', async () => {
    await service.pruneInvalidTokens([]);
    expect(devicesRepo.delete).not.toHaveBeenCalled();
  });

  it('pruneInvalidTokens deletes rows matching any of the provided tokens', async () => {
    await service.pruneInvalidTokens(['a', 'b']);
    expect(devicesRepo.delete).toHaveBeenCalled();
  });
});
