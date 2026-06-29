import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Admin: send a push notification to ONE user. Used from the admin
 * user-detail screen when ops needs to ping a single student (welcome
 * pack, billing chase, partnership note). Broadcasts to segments
 * stay on the existing `POST /admin/notifications` endpoint.
 */
export class SendUserPushDto {
  /** 1–80 chars — matches the Firebase title hard limit (200) generously. */
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  title!: string;

  /** Up to 280 chars — comfortably under FCM's 1024 limit, generous for a message. */
  @ApiProperty({ minLength: 1, maxLength: 280 })
  @IsString()
  @MinLength(1)
  @MaxLength(280)
  body!: string;

  /**
   * Optional deep link. The mobile NotificationDeepLinks handler
   * reads `data.deepLink` and routes there on tap. Free-form so the
   * admin can target any in-app route (e.g. `/settings/subscription`).
   */
  @ApiPropertyOptional({ description: 'In-app deep link to open on tap.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deepLink?: string;
}
