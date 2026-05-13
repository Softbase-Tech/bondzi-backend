import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiGenerationJob } from './entities/ai-generation-job.entity';
import { Question } from '../questions/entities/question.entity';
import { Option } from '../questions/entities/option.entity';
import { AdminExplanationsController } from './admin-explanations.controller';
import { AdminExplanationsService } from './admin-explanations.service';
import { AiModule } from '../ai/ai.module';
import { QUEUE_AI_GENERATION } from '../ai/ai.queues';

@Module({
  imports: [
    TypeOrmModule.forFeature([AiGenerationJob, Question, Option]),
    BullModule.registerQueue({ name: QUEUE_AI_GENERATION }),
    AiModule,
  ],
  controllers: [AdminExplanationsController],
  providers: [AdminExplanationsService],
  exports: [AdminExplanationsService, TypeOrmModule],
})
export class AdminAiGenModule {}
