import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UserSubject } from './entities/user-subject.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { UserSubjectProgress } from '../progress/entities/user-subject-progress.entity';
import { Exam } from '../exams/entities/exam.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserSubject,
      Subject,
      Subscription,
      UserSubjectProgress,
      Exam,
      ExamAnswer,
    ]),
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
