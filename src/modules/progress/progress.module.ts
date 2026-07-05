import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserSubjectProgress } from './entities/user-subject-progress.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { Topic } from '../subjects/entities/topic.entity';
import { PmTestQuestion } from '../pm-test/entities/pm-test-question.entity';
import { SyllabusTopic } from '../subjects/entities/syllabus-topic.entity';
import { WeaknessService } from './weakness.service';
import { WeaknessController } from './weakness.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserSubjectProgress,
      ExamAnswer,
      Question,
      Topic,
      PmTestQuestion,
      SyllabusTopic,
    ]),
  ],
  controllers: [WeaknessController],
  providers: [WeaknessService],
  exports: [TypeOrmModule, WeaknessService],
})
export class ProgressModule {}
