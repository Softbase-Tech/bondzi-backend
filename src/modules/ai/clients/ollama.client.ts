import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  AiGenerationClient,
  AiInvokeParams,
  AiInvokeResult,
} from './ai-generation-client.interface';

/**
 * Local / self-hosted LLM client for batch question + explanation
 * generation. Talks to Ollama's OpenAI-compatible endpoint at
 * `${OLLAMA_BASE_URL}/v1/chat/completions`, using the model named in
 * `OLLAMA_MODEL` — that's the ONLY place the model name is
 * consulted, so switching model is a single env-var flip.
 *
 * Why an OpenAI-compat endpoint rather than Ollama's native
 * `/api/chat`: the OpenAI shape returns `usage.prompt_tokens` and
 * `usage.completion_tokens` which we already log per-call. Ollama's
 * native shape wraps the same numbers under different key names —
 * this saves a translation layer.
 *
 * Modes of failure this client considers "cleanly recoverable":
 *   • connection refused → Ollama isn't running. Surface a clear
 *     ServiceUnavailableException so the admin sees "start Ollama".
 *   • 4xx from Ollama → model not loaded / bad request. Log and
 *     surface as ServiceUnavailableException — retrying isn't going
 *     to help without operator action.
 *   • 5xx / timeout → same as Bedrock's throttle path. Let the
 *     BullMQ retry policy handle re-attempts.
 *
 * DPA note: this client is only intended for prompts that carry NO
 * per-student data (question generation, explanation generation).
 * Weakness narratives / post-exam breakdowns MUST pin to BedrockClient
 * directly — the factory doesn't select this client for those services.
 */
@Injectable()
export class OllamaClient implements AiGenerationClient {
  private readonly log = new Logger(OllamaClient.name);
  private readonly baseUrl = (
    process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'
  ).replace(/\/$/, '');
  private readonly model = process.env.OLLAMA_MODEL ?? 'llama3.1:8b';
  // Local generation is slower per token than Bedrock — an 8B model on
  // CPU can take 60-90s for a 1k-token generation. Give it room. The
  // BullMQ worker's timeout is what actually gates job total wall-clock.
  private readonly requestTimeoutMs = Number(
    process.env.OLLAMA_REQUEST_TIMEOUT_MS ?? 120_000,
  );

  async invoke(params: AiInvokeParams): Promise<AiInvokeResult> {
    // modelId is IGNORED. This is deliberate — Ollama's model is
    // set by env, not per-call, so the caller (AiService) doesn't
    // have to know which provider is active.
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (params.system)
      messages.push({ role: 'system', content: params.system });
    messages.push({ role: 'user', content: params.userPrompt });

    const body = {
      model: this.model,
      messages,
      max_tokens: params.maxTokens ?? 1024,
      temperature: params.temperature ?? 0.3,
      // stream=false so we get the usage block in one JSON. Streaming
      // is nice for UX but this is a batch worker — nothing renders
      // token-by-token.
      stream: false,
    };

    const url = `${this.baseUrl}/v1/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const message = (err as Error)?.message ?? 'unknown';
      // AbortError for our timeout, ECONNREFUSED for Ollama not running.
      // Both surface as SERVICE_UNAVAILABLE so the admin AI monitor and
      // the BullMQ retry logic treat them consistently.
      this.log.warn(
        `[ollama] transport failure model=${this.model} err=${message}`,
      );
      throw new ServiceUnavailableException(
        `Local AI (Ollama) unreachable at ${this.baseUrl}: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      this.log.warn(
        `[ollama] non-2xx model=${this.model} status=${res.status} body=${bodyText.slice(0, 200)}`,
      );
      throw new ServiceUnavailableException(
        `Local AI (Ollama) returned ${res.status}: ${bodyText.slice(0, 200)}`,
      );
    }

    const decoded = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = decoded.choices?.[0]?.message?.content?.trim() ?? '';
    return {
      text,
      inputTokens: decoded.usage?.prompt_tokens ?? 0,
      outputTokens: decoded.usage?.completion_tokens ?? 0,
      // Log-friendly provenance tag — see ai_usage_log write path.
      effectiveModel: `ollama:${this.model}`,
    };
  }
}
