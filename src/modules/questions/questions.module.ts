import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../admin/entities/audit-log.entity';
import { Question } from './entities/question.entity';
import { Option } from './entities/option.entity';
import { QuestionFlag } from './entities/question-flag.entity';
import { QuestionStimulus } from './entities/question-stimulus.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { SrsCard } from '../srs/entities/srs-card.entity';
import { UserSubjectProgress } from '../progress/entities/user-subject-progress.entity';
import { Topic } from '../subjects/entities/topic.entity';
import { QuestionsController } from './questions.controller';
import { QuestionsService } from './questions.service';
import { StimuliAdminController } from './stimuli-admin.controller';
import { StimuliService } from './stimuli.service';
import { ExplanationsController } from './explanations.controller';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Question,
      Option,
      QuestionFlag,
      QuestionStimulus,
      PmTestQuestion,
      SrsCard,
      UserSubjectProgress,
      AuditLog,
      Topic,
      // Read/write access for the explanation-viewed instrumentation
      // (explanations.controller marks exam_answers.explanation_viewed).
      ExamAnswer,
    ]),
    SubscriptionsModule,
    // Explanations meter in-handler (consume-after-success) instead of
    // via the @RequiresService guard — see explanations.controller.
    EntitlementsModule,
  ],
  controllers: [
    QuestionsController,
    StimuliAdminController,
    ExplanationsController,
  ],
  providers: [QuestionsService, StimuliService],
  exports: [QuestionsService, StimuliService, TypeOrmModule],
})
export class QuestionsModule {}
