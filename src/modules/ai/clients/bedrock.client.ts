import { Injectable, Logger } from '@nestjs/common';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  ThrottlingException,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type {
  AiGenerationClient,
  AiInvokeParams,
  AiInvokeResult,
} from './ai-generation-client.interface';

/**
 * Thin wrapper around AWS Bedrock's InvokeModel for Anthropic Claude.
 *
 * Why a separate client from `AiService`:
 *   - Keeps the AWS SDK / regional auth concerns in one place.
 *   - `AiService` keeps owning cost tracking, prompt-template loading, and
 *     daily-budget enforcement — none of which know about Bedrock specifics.
 *   - Auth is IAM-based (resolved from the AWS_* env vars / EC2 metadata),
 *     not API-key. The SDK does the right thing automatically.
 *
 * Bedrock wraps Anthropic's Messages API. The body schema is identical to
 * the direct Anthropic API — only the model IDs (`anthropic.claude-...-v1:0`)
 * and the auth path change. Token counts come back on `usage.input_tokens`
 * / `usage.output_tokens`, same shape as the Anthropic SDK.
 */
/** Bedrock per-request timeouts. AWS SDK's default socket timeout is */
/** effectively infinite — a hung Bedrock call would otherwise hold the */
/** worker (and the BullMQ slot) indefinitely. 30s is a generous ceiling */
/** even for max_tokens=4096 generations. */
const BEDROCK_REQUEST_TIMEOUT_MS = 30_000;
const BEDROCK_CONNECTION_TIMEOUT_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class BedrockClient implements AiGenerationClient {
  private readonly log = new Logger(BedrockClient.name);
  private readonly maxRetries = Math.max(
    0,
    Number(process.env.AI_BEDROCK_MAX_RETRIES ?? 3),
  );
  private readonly client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION,
    maxAttempts: this.maxRetries,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: BEDROCK_CONNECTION_TIMEOUT_MS,
      requestTimeout: BEDROCK_REQUEST_TIMEOUT_MS,
    }),
  });

  /**
   * Client-side request pacing. Bedrock enforces an account-level
   * requests-per-minute quota per model (e.g. a fresh account is granted just
   * 10 RPM for cross-region Claude); firing a bulk job's calls back-to-back
   * trips it and every overflow request is thrown away. We space calls to stay
   * under `AI_BEDROCK_MAX_RPM`. Set it to your *granted* RPM (leave headroom,
   * e.g. 80%); the throttle-retry below absorbs the occasional overshoot.
   *
   * Pacing is per-process: the worker runs bulk generation through this single
   * instance, so it's properly serialized there. `nextSlotAt` is reserved
   * synchronously (no await between read and write) so concurrent callers each
   * grab a distinct, evenly-spaced slot.
   */
  private readonly maxRpm = Math.max(
    1,
    Number(process.env.AI_BEDROCK_MAX_RPM ?? 10),
  );
  private readonly minIntervalMs = Math.ceil(60_000 / this.maxRpm);
  private nextSlotAt = 0;

  private async pace(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.minIntervalMs;
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
  }

  async invoke(params: AiInvokeParams): Promise<AiInvokeResult> {
    await this.pace();
    // Retry ThrottlingException with real backoff. The AWS SDK's own retries
    // (maxAttempts) fire in milliseconds — useless against a per-minute quota —
    // so on an exhausted throttle we wait seconds and try again rather than
    // discarding the item as a permanent failure.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.sendOnce(params);
      } catch (err) {
        if (err instanceof ThrottlingException && attempt < this.maxRetries) {
          const backoff = Math.min(30_000, 2_000 * 2 ** attempt);
          this.log.warn(
            `Bedrock throttled (${params.modelId}); retry ${attempt + 1}/${this.maxRetries} in ${backoff}ms`,
          );
          await sleep(backoff);
          continue;
        }
        throw err;
      }
    }
  }

  private async sendOnce(params: AiInvokeParams): Promise<AiInvokeResult> {
    const body: Record<string, unknown> = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: params.maxTokens ?? 1024,
      temperature: params.temperature ?? 0.3,
      messages: [{ role: 'user', content: params.userPrompt }],
    };
    if (params.system) body.system = params.system;

    const cmd = new InvokeModelCommand({
      modelId: params.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    });

    const res = await this.client.send(cmd);
    const decoded = JSON.parse(new TextDecoder().decode(res.body)) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text =
      (decoded.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n')
        .trim() ?? '';
    return {
      text,
      inputTokens: decoded.usage?.input_tokens ?? 0,
      outputTokens: decoded.usage?.output_tokens ?? 0,
      effectiveModel: params.modelId,
    };
  }
}
