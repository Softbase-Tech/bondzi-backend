import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';
import { Notification as NotificationEntity } from './entities/notification.entity';

interface MobileNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

/**
 * Map the persisted Notification entity to the wire shape the mobile app
 * (Zod `NotificationSchema` in lib/validators/index.ts) consumes:
 *   - `type` is what the in-app router uses to deep-link, so prefer the
 *     `data.type` set by the sender; fall back to the `channel` so the row
 *     never lacks a string here.
 *   - `readAt` is a nullable timestamp the UI uses to gate the unread badge.
 *     The DB only stores `is_read: bool`; surface `sent_at` (or `created_at`)
 *     when the row has been read.
 */
function toMobileNotification(n: NotificationEntity): MobileNotification {
  const data = n.data ?? {};
  const explicitType =
    typeof (data as { type?: unknown }).type === 'string'
      ? (data as { type: string }).type
      : null;
  return {
    id: n.id,
    type: explicitType ?? n.channel,
    title: n.title,
    body: n.body,
    data,
    readAt: n.isRead ? (n.sentAt ?? n.createdAt).toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  };
}

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MobileNotification[]> {
    const rows = await this.notifications.listForUser(user.id);
    return rows.map(toMobileNotification);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAllRead(@CurrentUser() user: AuthenticatedUser) {
    await this.notifications.markAllRead(user.id);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.notifications.markRead(user.id, id);
  }

  @Post('push-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async registerPushToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterPushTokenDto,
  ) {
    await this.notifications.registerPushToken({
      userId: user.id,
      platform: dto.platform,
      fcmToken: dto.fcmToken,
      deviceId: dto.deviceId,
      appVersion: dto.appVersion,
    });
  }
}
