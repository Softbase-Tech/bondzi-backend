import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Transactional mail. Marked @Global so consumers don't have to add a
 * MailModule import to every feature module — once it's loaded at the
 * root, MailService is available everywhere.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
