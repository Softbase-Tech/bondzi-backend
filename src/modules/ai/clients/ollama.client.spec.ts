import { ServiceUnavailableException } from '@nestjs/common';
import { OllamaClient } from './ollama.client';

/**
 * OllamaClient talks to the OpenAI-compatible endpoint via `fetch`.
 * Tests stub `global.fetch` to assert:
 *   - the URL, method, headers, body shape
 *   - happy path parsing (text, tokens, effectiveModel tag)
 *   - non-2xx surfaces as ServiceUnavailableException
 *   - network refusal (connection refused / AbortError) surfaces as
 *     ServiceUnavailableException with a useful message
 *
 * ENV vars are set inline per test so we exercise the env-driven
 * model + base URL wiring without a beforeEach cascade.
 */
describe('OllamaClient', () => {
  const originalEnv = {
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    OLLAMA_REQUEST_TIMEOUT_MS: process.env.OLLAMA_REQUEST_TIMEOUT_MS,
  };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    process.env.OLLAMA_MODEL = 'llama3.1:8b';
    // Short timeout so the abort path in the network-failure test
    // resolves quickly.
    process.env.OLLAMA_REQUEST_TIMEOUT_MS = '5000';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    global.fetch = originalFetch;
  });

  it('POSTs to /v1/chat/completions with the OpenAI-shape body and returns effectiveModel=ollama:<model>', async () => {
    const mockFetch: jest.Mock<
      Promise<Response>,
      [RequestInfo, RequestInit?]
    > = jest.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (_url: RequestInfo, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'the answer' } }],
            usage: { prompt_tokens: 12, completion_tokens: 7 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const client = new OllamaClient();
    const result = await client.invoke({
      // modelId is IGNORED by Ollama by design — pass anything.
      modelId: 'anthropic.claude-haiku',
      system: 'you are helpful',
      userPrompt: 'why is the sky blue?',
      maxTokens: 512,
      temperature: 0.2,
    });

    expect(result.text).toBe('the answer');
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(7);
    expect(result.effectiveModel).toBe('ollama:llama3.1:8b');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
      temperature: number;
      stream: boolean;
    };
    expect(body.model).toBe('llama3.1:8b');
    expect(body.messages).toEqual([
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'why is the sky blue?' },
    ]);
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBe(0.2);
    expect(body.stream).toBe(false);
  });

  it('omits the system message when no system prompt is provided', async () => {
    const mockFetch: jest.Mock<
      Promise<Response>,
      [RequestInfo, RequestInit?]
    > = jest.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (_url: RequestInfo, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
          { status: 200 },
        ),
    );
    global.fetch = mockFetch as unknown as typeof fetch;
    const client = new OllamaClient();
    await client.invoke({ modelId: 'x', userPrompt: 'hi' });
    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    ) as { messages: Array<{ role: string }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
  });

  it('surfaces a 5xx as ServiceUnavailableException with status + body preview', async () => {
    const mockFetch: jest.Mock<
      Promise<Response>,
      [RequestInfo, RequestInit?]
    > = jest.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (_url: RequestInfo, _init?: RequestInit) =>
        new Response('upstream broken', { status: 503 }),
    );
    global.fetch = mockFetch as unknown as typeof fetch;
    const client = new OllamaClient();
    await expect(
      client.invoke({ modelId: 'x', userPrompt: 'hi' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      client.invoke({ modelId: 'x', userPrompt: 'hi' }),
    ).rejects.toThrow(/503/);
  });

  it('surfaces a fetch network failure as ServiceUnavailableException with the base URL in the message', async () => {
    // Simulate connection-refused. The client wraps this as a
    // ServiceUnavailableException — same code path the admin AI
    // monitor sees when Ollama isn't running.
    global.fetch = jest.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    }) as unknown as typeof fetch;

    const client = new OllamaClient();
    await expect(
      client.invoke({ modelId: 'x', userPrompt: 'hi' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      client.invoke({ modelId: 'x', userPrompt: 'hi' }),
    ).rejects.toThrow(/localhost:11434/);
  });

  it('tolerates a missing usage block (tokens fall back to 0)', async () => {
    const mockFetch: jest.Mock<
      Promise<Response>,
      [RequestInfo, RequestInit?]
    > = jest.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (_url: RequestInfo, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'text' } }] }),
          { status: 200 },
        ),
    );
    global.fetch = mockFetch as unknown as typeof fetch;
    const client = new OllamaClient();
    const result = await client.invoke({ modelId: 'x', userPrompt: 'hi' });
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});
