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
import { WeaknessService } from './weakness.service';
import { WeaknessNarrativeService } from './weakness-narrative.service';
import { WeaknessController } from './weakness.controller';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { AiModule } from '../ai/ai.module';

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
    ]),
    EntitlementsModule,
    AiModule,
  ],
  controllers: [WeaknessController],
  providers: [WeaknessService, WeaknessNarrativeService],
  exports: [TypeOrmModule, WeaknessService, WeaknessNarrativeService],
})
export class ProgressModule {}
