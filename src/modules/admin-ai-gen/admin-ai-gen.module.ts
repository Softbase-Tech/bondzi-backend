import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiGenerationJob } from './entities/ai-generation-job.entity';
import { Question } from '../questions/entities/question.entity';
import { Option } from '../questions/entities/option.entity';
import { AdminExplanationsController } from './admin-explanations.controller';
import { AdminExplanationsService } from './admin-explanations.service';
import { AiGenerationController } from './ai-generation.controller';
import { AiModule } from '../ai/ai.module';
import { PmTestModule } from '../pm-test/pm-test.module';
import { QUEUE_AI_GENERATION } from '../ai/ai.queues';

/**
 * Hosts:
 *   - AdminExplanationsController  (resource: explanations)
 *   - AiGenerationController       (unified façade for the admin UI;
 *     delegates to AdminExplanationsService + AdminPmTestService)
 *
 * `forwardRef(() => PmTestModule)` because PmTestModule also depends
 * on entities exported from here; the cycle is broken by Nest at DI
 * resolution time.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AiGenerationJob, Question, Option]),
    BullModule.registerQueue({ name: QUEUE_AI_GENERATION }),
    AiModule,
    forwardRef(() => PmTestModule),
  ],
  controllers: [AdminExplanationsController, AiGenerationController],
  providers: [AdminExplanationsService],
  exports: [AdminExplanationsService, TypeOrmModule],
})
export class AdminAiGenModule {}
