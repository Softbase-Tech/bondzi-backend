import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserSubjectProgress } from './entities/user-subject-progress.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { Topic } from '../subjects/entities/topic.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { SyllabusTopic } from '../subjects/entities/syllabus-topic.entity';
import { WeaknessNarrative } from './entities/weakness-narrative.entity';
import { AiReview } from './entities/ai-review.entity';
import { AiReviewConfig } from './entities/ai-review-config.entity';
import { User } from '../users/entities/user.entity';
import { WeaknessService } from './weakness.service';
import { StudentSignalService } from './student-signal.service';
import { WeaknessNarrativeService } from './weakness-narrative.service';
import { AiReviewService } from './ai-review.service';
import { AiReviewConfigService } from './ai-review-config.service';
import { WeaknessController } from './weakness.controller';
import { AiReviewController } from './ai-review.controller';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { AiModule } from '../ai/ai.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SyllabusModule } from '../syllabus/syllabus.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserSubjectProgress,
      ExamAnswer,
      Question,
      Subject,
      Topic,
      PmTestQuestion,
      SyllabusTopic,
      WeaknessNarrative,
      AiReview,
      AiReviewConfig,
      User,
    ]),
    EntitlementsModule,
    AiModule,
    SubscriptionsModule,
    // KnowledgeRetrievalService: StudentSignalService cites textbook
    // sections for weak topics (premium plan §6.2).
    SyllabusModule,
  ],
  controllers: [WeaknessController, AiReviewController],
  providers: [
    WeaknessService,
    StudentSignalService,
    WeaknessNarrativeService,
    AiReviewService,
    AiReviewConfigService,
  ],
  exports: [
    TypeOrmModule,
    WeaknessService,
    StudentSignalService,
    WeaknessNarrativeService,
    AiReviewService,
    AiReviewConfigService,
  ],
})
export class ProgressModule {}
