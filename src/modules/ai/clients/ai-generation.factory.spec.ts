import type { FactoryProvider } from '@nestjs/common';
import { aiGenerationClientProvider } from './ai-generation.factory';
import type { BedrockClient } from './bedrock.client';
import type { OllamaClient } from './ollama.client';

/**
 * The factory is a value provider — its resolution logic is a plain
 * function. We can call `useFactory` directly with two lightweight
 * stubs and assert which client comes back for each `AI_PROVIDER`
 * value. NestJS DI isn't exercised here; that's covered by the
 * integration test wiring in ai.service.spec.
 */
describe('aiGenerationClientProvider (factory)', () => {
  const bedrock = { invoke: jest.fn() } as unknown as BedrockClient;
  const ollama = { invoke: jest.fn() } as unknown as OllamaClient;
  // aiGenerationClientProvider is a FactoryProvider, but the DI
  // container's `Provider` union hides `useFactory` on the base
  // type. Narrow it here for the test.
  const factory = (aiGenerationClientProvider as FactoryProvider)
    .useFactory as (b: BedrockClient, o: OllamaClient) => unknown;

  const originalProvider = process.env.AI_PROVIDER;
  afterEach(() => {
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
  });

  it('returns BedrockClient when AI_PROVIDER is unset (default path)', () => {
    delete process.env.AI_PROVIDER;
    expect(factory(bedrock, ollama)).toBe(bedrock);
  });

  it('returns BedrockClient when AI_PROVIDER=bedrock', () => {
    process.env.AI_PROVIDER = 'bedrock';
    expect(factory(bedrock, ollama)).toBe(bedrock);
  });

  it('returns OllamaClient when AI_PROVIDER=self_hosted', () => {
    process.env.AI_PROVIDER = 'self_hosted';
    expect(factory(bedrock, ollama)).toBe(ollama);
  });

  it('falls back to BedrockClient on an unknown AI_PROVIDER (safe default)', () => {
    process.env.AI_PROVIDER = 'anthropic-direct-typo';
    expect(factory(bedrock, ollama)).toBe(bedrock);
  });

  it('is case-insensitive on the value', () => {
    process.env.AI_PROVIDER = ' Self_Hosted ';
    expect(factory(bedrock, ollama)).toBe(ollama);
  });
});
