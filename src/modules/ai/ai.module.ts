import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { PromptTemplate } from './entities/prompt-template.entity';
import { AiService } from './ai.service';

@Module({
  imports: [TypeOrmModule.forFeature([AiUsageLog, PromptTemplate])],
  providers: [AiService],
  exports: [AiService, TypeOrmModule],
})
export class AiModule {}
