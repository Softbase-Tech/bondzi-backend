import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { PromptTemplate } from './entities/prompt-template.entity';
import { AiGenerationRejectLog } from './entities/ai-generation-reject-log.entity';
import { AiGenerationRejectAgg } from './entities/ai-generation-reject-agg.entity';
import { AiService } from './ai.service';
import { RejectLogService } from './reject-log.service';
import { BedrockClient } from './clients/bedrock.client';
import { OllamaClient } from './clients/ollama.client';
import {
  AI_EMBEDDING_CLIENT,
  AI_GENERATION_CLIENT,
  aiEmbeddingClientProvider,
  aiGenerationClientProvider,
} from './clients/ai-generation.factory';
import { AdminRejectLogController } from './admin-reject-log.controller';
import { PromptExemplarService } from './prompt-exemplars.service';
import { Question } from '../questions/entities/question.entity';
import { Option } from '../questions/entities/option.entity';
import { SyllabusTopic } from '../subjects/entities/syllabus-topic.entity';

/**
 * Both concrete clients (Bedrock, Ollama) are registered as
 * providers so future services can inject either directly when
 * they need to bypass the factory — weakness narratives and
 * post-exam breakdowns pin to Bedrock regardless of AI_PROVIDER
 * (quality + cost — Haiku's fidelity on personalized text beats
 * a local 8B by a wide margin at ~$0.0009/call).
 *
 * Everything else injects `@Inject(AI_GENERATION_CLIENT)` and gets
 * whichever client the factory picked at boot.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiUsageLog,
      PromptTemplate,
      AiGenerationRejectLog,
      AiGenerationRejectAgg,
      Question,
      Option,
      SyllabusTopic,
    ]),
  ],
  controllers: [AdminRejectLogController],
  providers: [
    AiService,
    RejectLogService,
    BedrockClient,
    OllamaClient,
    aiGenerationClientProvider,
    aiEmbeddingClientProvider,
    PromptExemplarService,
  ],
  exports: [
    AiService,
    RejectLogService,
    BedrockClient,
    AI_GENERATION_CLIENT,
    AI_EMBEDDING_CLIENT,
    PromptExemplarService,
    TypeOrmModule,
  ],
})
export class AiModule {}
