import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiUsageLog } from './entities/ai-usage-log.entity';
import { AiEvalRun } from './entities/ai-eval-run.entity';
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
import { PromptTemplateRuntimeService } from './prompt-template-runtime.service';
import { AnswerVerifierService } from './verifiers/answer-verifier.service';
import { Question } from '../questions/entities/question.entity';
import { Option } from '../questions/entities/option.entity';
import { SyllabusTopic } from '../subjects/entities/syllabus-topic.entity';

/**
 * Both concrete clients (Bedrock, Ollama) are registered as
 * providers. The DPA pin for per-student prompts (weakness
 * narratives, AI reviews, post-exam breakdowns, chat tutor) is
 * ENFORCED IN CODE inside AiService.callBedrock via
 * STUDENT_DATA_ACTIONS — those actions dispatch to BedrockClient
 * directly regardless of AI_PROVIDER. Everything else goes through
 * `@Inject(AI_GENERATION_CLIENT)` and gets whichever client the
 * factory picked at boot.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiUsageLog,
      AiEvalRun,
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
    PromptTemplateRuntimeService,
    AnswerVerifierService,
  ],
  exports: [
    AiService,
    RejectLogService,
    BedrockClient,
    AI_GENERATION_CLIENT,
    AI_EMBEDDING_CLIENT,
    PromptExemplarService,
    PromptTemplateRuntimeService,
    AnswerVerifierService,
    TypeOrmModule,
  ],
})
export class AiModule {}
