import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Exam } from './entities/exam.entity';
import { ExamAnswer } from './entities/exam-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { Option } from '../questions/entities/option.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { PmTestOption } from '../pm-test/entities/pm-test-option.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { UserSubjectProgress } from '../progress/entities/user-subject-progress.entity';
import { User } from '../users/entities/user.entity';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';
import { SrsModule } from '../srs/srs.module';
import { GamificationModule } from '../gamification/gamification.module';
import { PartnersModule } from '../partners/partners.module';
import { ProgressModule } from '../progress/progress.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { AiModule } from '../ai/ai.module';
import { SyllabusModule } from '../syllabus/syllabus.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Exam,
      ExamAnswer,
      Question,
      Option,
      PmTestQuestion,
      PmTestOption,
      Subject,
      UserSubjectProgress,
      User,
    ]),
    SrsModule,
    GamificationModule,
    ReferralsModule,
    SubscriptionsModule,
    EntitlementsModule,
    AiModule,
    // PartnerCommissionsService: Streams B + C fire from
    // ExamsService.complete after an exam session finalises.
    PartnersModule,
    // WeaknessNarrativeService: bootstrap-row invalidation runs post-
    // completion so the next Home visit sees fresh signal.
    ProgressModule,
    // KnowledgeRetrievalService: post-exam review v2 cites textbook
    // sections for the missed topics (premium plan §6.5).
    SyllabusModule,
  ],
  controllers: [ExamsController],
  providers: [ExamsService],
  exports: [ExamsService, TypeOrmModule],
})
export class ExamsModule {}
