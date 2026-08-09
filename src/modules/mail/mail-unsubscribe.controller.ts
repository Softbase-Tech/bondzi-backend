import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Public } from '../../common/decorators/public.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('mail')
@Controller('mail')
export class MailUnsubscribeController {
  private readonly logger = new Logger(MailUnsubscribeController.name);

  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
  ) {}

  @Public()
  @Get('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'One-click unsubscribe from engagement emails (digest, streak nudges).',
  })
  async unsubscribe(@Query('token') token?: string): Promise<{ ok: boolean }> {
    const trimmed = (token ?? '').trim();
    if (!trimmed) return { ok: false };

    const user = await this.usersRepo.findOne({
      where: { emailUnsubscribeToken: trimmed },
    });
    if (!user) return { ok: false };

    user.emailWeeklyDigestEnabled = false;
    user.emailStreakNudgesEnabled = false;
    user.emailLevelUpEnabled = false;
    user.emailMarketingEnabled = false;
    await this.usersRepo.save(user);

    this.logger.log(`[mail] unsubscribed user=${user.id}`);
    return { ok: true };
  }
}
