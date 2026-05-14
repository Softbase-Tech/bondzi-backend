import { Test } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import {
  DevicePlatform,
  type UserDevice,
} from './entities/user-device.entity';
import type { Notification as NotificationEntity } from './entities/notification.entity';
import { NotificationChannel } from '../../common/types/enums';

/**
 *  - list: maps Notification entity → mobile wire shape (type pulled from
 *    data.type when present, else falls back to channel).
 *  - readAt is null when isRead=false, an ISO string when isRead=true.
 *  - markRead and registerPushToken just forward arguments.
 */

function makeRow(
  overrides: Partial<NotificationEntity> = {},
): NotificationEntity {
  return {
    id: 'n-1',
    userId: 'user-1',
    channel: NotificationChannel.PUSH,
    title: 'Hi',
    body: 'There',
    data: null,
    isRead: false,
    sentAt: null,
    createdAt: new Date('2026-05-13T00:00:00Z'),
    ...overrides,
  } as unknown as NotificationEntity;
}

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let notifications: jest.Mocked<NotificationsService>;

  beforeEach(async () => {
    notifications = {
      listForUser: jest.fn(),
      markRead: jest.fn(),
      registerPushToken: jest.fn(),
    } as unknown as jest.Mocked<NotificationsService>;

    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: notifications }],
    }).compile();
    controller = moduleRef.get(NotificationsController);
  });

  it('GET /notifications maps the entity to the mobile shape', async () => {
    notifications.listForUser.mockResolvedValueOnce([
      makeRow({ data: { type: 'srs_due' } as never }),
    ]);
    const out = await controller.list({ id: 'user-1' } as never);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(
      expect.objectContaining({
        id: 'n-1',
        type: 'srs_due', // pulled from data.type
        readAt: null,
      }),
    );
  });

  it('GET /notifications falls back to channel when data.type is missing', async () => {
    notifications.listForUser.mockResolvedValueOnce([makeRow()]);
    const out = await controller.list({ id: 'user-1' } as never);
    expect(out[0].type).toBe(NotificationChannel.PUSH);
  });

  it('GET /notifications surfaces readAt as an ISO string when read', async () => {
    notifications.listForUser.mockResolvedValueOnce([
      makeRow({ isRead: true, sentAt: new Date('2026-05-13T01:00:00Z') }),
    ]);
    const out = await controller.list({ id: 'user-1' } as never);
    expect(out[0].readAt).toBe('2026-05-13T01:00:00.000Z');
  });

  it('POST /notifications/:id/read forwards (userId, id)', async () => {
    await controller.markRead(
      { id: 'user-1' } as never,
      '00000000-0000-0000-0000-000000000001',
    );
    expect(notifications.markRead).toHaveBeenCalledWith(
      'user-1',
      '00000000-0000-0000-0000-000000000001',
    );
  });

  it('POST /notifications/push-token forwards the DTO with the user id attached', async () => {
    await controller.registerPushToken(
      { id: 'user-1' } as never,
      {
        platform: DevicePlatform.ANDROID,
        fcmToken: 'tok-1',
        deviceId: 'd1',
        appVersion: '1.0.0',
      } as never,
    );
    expect(notifications.registerPushToken).toHaveBeenCalledWith({
      userId: 'user-1',
      platform: DevicePlatform.ANDROID,
      fcmToken: 'tok-1',
      deviceId: 'd1',
      appVersion: '1.0.0',
    });
  });

  // Imports below are used purely to keep the entity types in scope so
  // the test file fails fast if a property is renamed on the entity.
  it('compiles with the entity types it depends on', () => {
    const _u: UserDevice = { fcmToken: 'x' } as UserDevice;
    expect(_u.fcmToken).toBe('x');
  });
});
