/**
 * Provider-agnostic contract for LLM generation calls. Any client the
 * factory returns implements this interface — the caller (AiService,
 * ai-generation.processor) never needs to know whether it's talking to
 * Bedrock or Ollama.
 *
 * Response shape mirrors what BedrockClient has always returned so
 * this abstraction is a lift, not a rewrite:
 *
 *   text         — the assistant's message content, joined into one string
 *   inputTokens  — best-effort. Bedrock returns exact counts; Ollama's
 *                  OpenAI-compat endpoint returns `prompt_tokens` when
 *                  configured to and 0 otherwise. Callers should tolerate 0.
 *   outputTokens — same caveat as inputTokens.
 */
export interface AiInvokeParams {
  /**
   * Bedrock model id (`anthropic.claude-...-v1:0`). Passed through
   * verbatim to BedrockClient. IGNORED by OllamaClient — Ollama uses
   * OLLAMA_MODEL env var instead so its model can be flipped without
   * touching any per-call code.
   */
  modelId: string;
  system?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiInvokeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * The model that actually ran. For Bedrock this is `modelId`
   * verbatim; for Ollama it's `ollama:${OLLAMA_MODEL}` so the usage
   * log carries a clean provenance tag.
   */
  effectiveModel: string;
}

export interface AiEmbedParams {
  /** Texts to embed, in order. The result vectors line up by index. */
  texts: string[];
  /**
   * Bedrock embedding model id (e.g. `amazon.titan-embed-text-v2:0`).
   * Passed through verbatim to BedrockClient. IGNORED by OllamaClient —
   * Ollama uses `OLLAMA_EMBEDDING_MODEL` env instead.
   */
  modelId: string;
}

export interface AiEmbedResult {
  /** One vector per input text, in the same order. */
  vectors: number[][];
  /** The model that actually ran (`ollama:<name>` for local). */
  effectiveModel: string;
  /** Best-effort total input tokens (0 when the provider doesn't report). */
  inputTokens: number;
}

export interface AiGenerationClient {
  invoke(params: AiInvokeParams): Promise<AiInvokeResult>;
  /**
   * Embed one or more texts into vectors for semantic retrieval. The
   * SAME model must be used at ingest time and query time — vectors from
   * different models are not comparable.
   */
  embed(params: AiEmbedParams): Promise<AiEmbedResult>;
}
