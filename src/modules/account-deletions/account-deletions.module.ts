import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountDeletion } from './entities/account-deletion.entity';
import { User } from '../users/entities/user.entity';
import { DeviceSession } from '../auth/entities/device-session.entity';
import { MailModule } from '../mail/mail.module';
import { AccountDeletionsService } from './account-deletions.service';

/**
 * Account-deletion lifecycle. Uses the User + DeviceSession repos directly
 * (rather than importing UsersModule/AuthModule) to stay free of circular
 * deps — UsersModule imports THIS module for DELETE /users/me.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AccountDeletion, User, DeviceSession]),
    MailModule,
  ],
  providers: [AccountDeletionsService],
  exports: [AccountDeletionsService],
})
export class AccountDeletionsModule {}
