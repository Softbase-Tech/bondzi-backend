import {
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../../../common/decorators/public.decorator';
import { User } from '../../users/entities/user.entity';
import { verifySvixWebhook } from './svix-verify.util';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

interface ResendWebhookPayload {
  type: string;
  data?: {
    email_id?: string;
    to?: string[];
    bounce?: { message?: string };
  };
}

@ApiTags('mail-webhooks')
@Controller('mail/webhooks')
export class ResendWebhookController {
  private readonly logger = new Logger(ResendWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
  ) {}

  @Public()
  @Post('resend')
  @ApiExcludeEndpoint()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 200, ttl: 60_000 } })
  async handleResend(@Req() req: RawBodyRequest): Promise<{ status: string }> {
    const secret = this.config.get<string>('mail.webhookSecret') ?? '';
    const rawBody = req.rawBody;
    if (!rawBody) throw new ForbiddenException('Missing raw body');
    if (!secret) {
      this.logger.warn(
        '[resend-webhook] RESEND_WEBHOOK_SECRET not set — rejecting',
      );
      throw new ForbiddenException('Webhook not configured');
    }

    if (
      !verifySvixWebhook(rawBody, req.headers as Record<string, string>, secret)
    ) {
      throw new ForbiddenException('Invalid signature');
    }

    let payload: ResendWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as ResendWebhookPayload;
    } catch {
      throw new ForbiddenException('Invalid JSON');
    }

    const type = payload.type ?? '';
    if (type === 'email.bounced' || type === 'email.complained') {
      await this.suppressRecipient(payload.data?.to?.[0], type);
    }

    this.logger.log(`[resend-webhook] type=${type}`);
    return { status: 'ok' };
  }

  private async suppressRecipient(
    email: string | undefined,
    type: string,
  ): Promise<void> {
    if (!email) return;
    const result = await this.usersRepo
      .createQueryBuilder()
      .update(User)
      .set({ emailBouncedAt: new Date() })
      .where('lower(email) = lower(:email)', { email })
      .execute();
    if ((result.affected ?? 0) > 0) {
      this.logger.warn(`[resend-webhook] suppressed ${email} after ${type}`);
    }
  }
}
