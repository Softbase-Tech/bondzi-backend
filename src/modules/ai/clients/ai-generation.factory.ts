import { Logger, Provider } from '@nestjs/common';
import { BedrockClient } from './bedrock.client';
import { OllamaClient } from './ollama.client';
import type { AiGenerationClient } from './ai-generation-client.interface';

/**
 * DI token for the resolved generation client. Consumers inject
 * `@Inject(AI_GENERATION_CLIENT) private readonly ai: AiGenerationClient`
 * — they never see BedrockClient or OllamaClient directly.
 *
 * Exception: services that MUST run on Bedrock regardless of the
 * global provider setting (weakness narratives, post-exam breakdowns
 * when built) inject `BedrockClient` directly, with a code comment
 * explaining why they bypass the factory. Everything else goes
 * through this token.
 */
export const AI_GENERATION_CLIENT = Symbol('AI_GENERATION_CLIENT');

/**
 * Reads `AI_PROVIDER` at module boot and returns the matching client.
 *   • `bedrock` (default) → BedrockClient
 *   • `self_hosted` → OllamaClient
 * Any other value falls back to Bedrock with a warn log — safer to
 * keep production alive than crash on a typo'd env value.
 */
export const aiGenerationClientProvider: Provider = {
  provide: AI_GENERATION_CLIENT,
  useFactory: (
    bedrock: BedrockClient,
    ollama: OllamaClient,
  ): AiGenerationClient => {
    const log = new Logger('AiGenerationFactory');
    const raw = (process.env.AI_PROVIDER ?? 'bedrock').trim().toLowerCase();
    if (raw === 'self_hosted') {
      log.log(
        `AI provider: ollama (base=${process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'}, model=${process.env.OLLAMA_MODEL ?? 'llama3.1:8b'})`,
      );
      return ollama;
    }
    if (raw !== 'bedrock') {
      log.warn(
        `AI_PROVIDER=${raw} unrecognised — falling back to bedrock. Valid values: bedrock, self_hosted.`,
      );
    } else {
      log.log('AI provider: bedrock');
    }
    return bedrock;
  },
  inject: [BedrockClient, OllamaClient],
};
