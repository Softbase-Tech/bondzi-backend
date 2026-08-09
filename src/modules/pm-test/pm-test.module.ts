import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PmTestQuestion } from './entities/pm-test-question.entity';
import { PmTestOption } from './entities/pm-test-option.entity';
import { Subject } from '../subjects/entities/subject.entity';
import { SyllabusTopic } from '../subjects/entities/syllabus-topic.entity';
import { User } from '../users/entities/user.entity';
import { ExamAnswer } from '../exams/entities/exam-answer.entity';
import { AiGenerationJob } from '../admin-ai-gen/entities/ai-generation-job.entity';
import { PmTestController } from './pm-test.controller';
import { AdminPmTestController } from './admin-pm-test.controller';
import { PmTestService } from './pm-test.service';
import { AdminPmTestService } from './admin-pm-test.service';
import { QUEUE_AI_GENERATION } from '../ai/ai.queues';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PmTestQuestion,
      PmTestOption,
      Subject,
      SyllabusTopic,
      User,
      ExamAnswer,
      AiGenerationJob,
    ]),
    BullModule.registerQueue({ name: QUEUE_AI_GENERATION }),
    // AdminPmTestService uses AiService.assertBatchWithinCap to
    // enforce AI_MAX_ITEMS_PER_BATCH before enqueueing.
    AiModule,
  ],
  controllers: [PmTestController, AdminPmTestController],
  providers: [PmTestService, AdminPmTestService],
  // AdminPmTestService is exported so the unified ai-generation façade
  // controller (lives in admin-ai-gen.module) can delegate to it.
  exports: [PmTestService, AdminPmTestService, TypeOrmModule],
})
export class PmTestModule {}
