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

@Injectable()
export class BedrockClient implements AiGenerationClient {
  private readonly log = new Logger(BedrockClient.name);
  private readonly client = new BedrockRuntimeClient({
    region: process.env.AWS_REGION,
    maxAttempts: Number(process.env.AI_BEDROCK_MAX_RETRIES ?? 3),
    requestHandler: new NodeHttpHandler({
      connectionTimeout: BEDROCK_CONNECTION_TIMEOUT_MS,
      requestTimeout: BEDROCK_REQUEST_TIMEOUT_MS,
    }),
  });

  async invoke(params: AiInvokeParams): Promise<AiInvokeResult> {
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

    try {
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
    } catch (err) {
      if (err instanceof ThrottlingException) {
        this.log.warn(`Bedrock throttled: ${params.modelId}`);
      }
      throw err;
    }
  }
}
