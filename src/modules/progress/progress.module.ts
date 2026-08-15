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
import { WeaknessService } from './weakness.service';
import { WeaknessNarrativeService } from './weakness-narrative.service';
import { AiReviewService } from './ai-review.service';
import { AiReviewConfigService } from './ai-review-config.service';
import { WeaknessController } from './weakness.controller';
import { AiReviewController } from './ai-review.controller';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { AiModule } from '../ai/ai.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

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
    ]),
    EntitlementsModule,
    AiModule,
    SubscriptionsModule,
  ],
  controllers: [WeaknessController, AiReviewController],
  providers: [
    WeaknessService,
    WeaknessNarrativeService,
    AiReviewService,
    AiReviewConfigService,
  ],
  exports: [
    TypeOrmModule,
    WeaknessService,
    WeaknessNarrativeService,
    AiReviewService,
    AiReviewConfigService,
  ],
})
export class ProgressModule {}
