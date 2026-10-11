/**
 * OpenAI-compatible failures inside a 200 response, the request `timeout`,
 * repeated tool-call ids and unparseable tool calls, through the REAL
 * installed `@ai-sdk/openai` (whichever major CI installs) against a local
 * HTTP server - no stubbed `ai` module, so the provider package's own finish
 * reason mapping is what is tested.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OpenAIProvider } from './OpenAIProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import type { LLMProvider } from './llm';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { CompactedLLMProviderError } from '../execution/errors';

type Reply = { json: unknown; delayMs?: number } | { sse: Array<unknown>; delayMs?: number };

interface FakeServer {
  url: string;
  requests: Array<Record<string, unknown>>;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});

/** A chat-completions server answering request `n` with `reply(n, body)`. */
async function fakeServer(reply: (n: number, body: Record<string, unknown>) => Reply): Promise<FakeServer> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const answer = reply(requests.length, body);
    requests.push(body);
    if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    if ('sse' in answer) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of answer.sse) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.json));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function completion(content: string | null, finish_reason: string, tool_calls?: unknown[]) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content, ...(tool_calls && { tool_calls }) }, finish_reason }],
    usage,
  };
}

const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-s',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-4o-mini',
  choices,
  ...extra,
});

function textStream(text: string, finish_reason = 'stop'): unknown[] {
  return [
    chunk([{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason }]),
    chunk([], { usage }),
  ];
}

/** The two OpenAI-compatible chat providers, pointed at `server`. */
const providers: Array<[string, (server: FakeServer, config?: { timeout?: number }) => LLMProvider]> = [
  ['openai (api: chat)', (server, config) => new OpenAIProvider({ apiKey: 'k', baseURL: server.url, api: 'chat', ...config })],
  ['openrouter', (server, config) => new OpenRouterProvider({ apiKey: 'k', baseURL: server.url, ...config })],
];

const fast = { maxRetries: 2, backoff: { initialMs: 1, jitter: false } };

describe.each(providers)("in-response failures fail the call: %s", (_name, make) => {
  it("finish_reason 'error' in a JSON reply is a retryable 502, retried, then thrown", async () => {
    const server = await fakeServer(() => ({ json: completion('The answer is 4', 'error') }));
    const agent = createAgent({ provider: make(server), instructions: 'x', retry: fast });

    const error = await agent.send('2+2?').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CompactedLLMProviderError);
    expect((error as CompactedLLMProviderError).compacted).toMatchObject({ statusCode: 502, retryable: true });
    expect(server.requests).toHaveLength(3);
  });

  it("a retry after finish_reason 'error' recovers", async () => {
    const server = await fakeServer((n) => ({ json: completion(n === 0 ? 'cut o' : 'The answer is 4', n === 0 ? 'error' : 'stop') }));
    const result = await createAgent({ provider: make(server), instructions: 'x', retry: fast }).send('2+2?');

    expect(result.text).toBe('The answer is 4');
    expect(server.requests).toHaveLength(2);
  });

  it("a stream that ends with finish_reason 'error' after its text rejects (no truncated success)", async () => {
    const server = await fakeServer(() => ({ sse: textStream('The answer is 4', 'error') }));
    const run = createAgent({ provider: make(server), instructions: 'x', retry: fast }).stream('2+2?');

    await expect(run.result).rejects.toMatchObject({ compacted: { statusCode: 502 } });
  });

  it("an error chunk mid-stream (OpenRouter's documented shape) rejects with its message", async () => {
    const server = await fakeServer(() => ({
      sse: [
        chunk([{ index: 0, delta: { role: 'assistant', content: 'Partial ans' }, finish_reason: null }]),
        chunk([{ index: 0, delta: { content: '' }, finish_reason: 'error' }], { error: { code: 502, message: 'Upstream died' } }),
      ],
    }));
    const run = createAgent({ provider: make(server), instructions: 'x', retry: fast }).stream('2+2?');

    await expect(run.result).rejects.toThrow(/Upstream died/);
  });

  it('an error chunk before any text is retried, and the retry streams the answer', async () => {
    const server = await fakeServer((n) =>
      n === 0
        ? { sse: [chunk([{ index: 0, delta: { content: '' }, finish_reason: 'error' }], { error: { code: 503, message: 'overloaded' } })] }
        : { sse: textStream('recovered') }
    );
    const result = await createAgent({ provider: make(server), instructions: 'x', retry: fast }).stream('hi').result;

    expect(result.text).toBe('recovered');
    expect(server.requests).toHaveLength(2);
  });

  it('a normal reply still works and keeps its text and usage', async () => {
    const server = await fakeServer((_n, body) => (body.stream ? { sse: textStream('hello') } : { json: completion('hello', 'stop') }));
    const agent = createAgent({ provider: make(server), instructions: 'x', retry: false });

    expect((await agent.send('hi')).text).toBe('hello');
    const streamed = await agent.stream('hi').result;
    expect(streamed).toMatchObject({ text: 'hello', finishReason: 'stop' });
  });

  it('`timeout` bounds the wait for a response: a slow server fails with a retryable timeout', async () => {
    const server = await fakeServer(() => ({ json: completion('slow but ok', 'stop'), delayMs: 1_000 }));
    const agent = createAgent({ provider: make(server, { timeout: 100 }), instructions: 'x', retry: false });
    const started = Date.now();

    const error = await agent.send('hi').catch((caught: unknown) => caught);

    expect(Date.now() - started).toBeLessThan(900);
    expect((error as CompactedLLMProviderError).compacted).toMatchObject({ category: 'timeout', retryable: true });
  });
});

describe('tool calls through the real provider package', () => {
  const add = defineTool({
    name: 'add',
    description: 'Adds two numbers',
    input: z.object({ a: z.number(), b: z.number() }),
    execute: ({ a, b }) => ({ sum: a + b }),
  });

  const call = (id: string, args: string) => ({ id, type: 'function', function: { name: 'add', arguments: args } });

  /** Each tool message the second request sent back. */
  const toolResults = (server: FakeServer) =>
    ((server.requests[1]?.messages ?? []) as Array<{ role: string; content: string; tool_call_id: string }>).filter((m) => m.role === 'tool');

  it('two calls with the same id both run, with their own arguments', async () => {
    const server = await fakeServer((n) => ({
      json: n === 0 ? completion(null, 'tool_calls', [call('dup', '{"a":1,"b":2}'), call('dup', '{"a":3,"b":4}')]) : completion('ok', 'stop'),
    }));
    const seen: unknown[] = [];
    const recorded = defineTool({ ...add, execute: (args: { a: number; b: number }) => (seen.push(args), { sum: args.a + args.b }) });
    const result = await createAgent({ provider: providers[0][1](server), tools: [recorded], instructions: 'x', retry: false }).send('go');

    expect(result.text).toBe('ok');
    expect(seen).toEqual([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
    const results = toolResults(server);
    expect(results.map((m) => JSON.parse(m.content) as unknown)).toEqual([{ sum: 3 }, { sum: 7 }]);
    expect(new Set(results.map((m) => m.tool_call_id)).size).toBe(2);
  });

  it.each([
    ['malformed JSON', '{"a":1,"b":', /JSON|parse/i],
    ['wrong types', '{"a":"1","b":2}', /a: Expected number/],
  ])('%s arguments reach the model as a tool error, and the run goes on (every ai major)', async (_case, args, message) => {
    const server = await fakeServer((n) => ({ json: n === 0 ? completion(null, 'tool_calls', [call('c1', args)]) : completion('ok', 'stop') }));
    const result = await createAgent({ provider: providers[0][1](server), tools: [add], instructions: 'x', retry: false }).send('go');

    expect(result.text).toBe('ok');
    const [tool] = toolResults(server);
    expect(tool.content).toMatch(message);
    expect(tool.content).not.toMatch(/\(root\): Expected object, received string/);
    // Sent once as the SDK's tool error, not wrapped again in `{"error": ...}` by the provider package (ai 7).
    expect(JSON.parse(tool.content)).toMatchObject({ error: 'ToolArgumentsValidationError', toolName: 'add', kind: 'validation' });
  });

  it('a call to an unknown tool reaches the model as a tool error (every ai major)', async () => {
    const unknown = { id: 'c1', type: 'function', function: { name: 'nope', arguments: '{}' } };
    const server = await fakeServer((n) => ({ json: n === 0 ? completion(null, 'tool_calls', [unknown]) : completion('ok', 'stop') }));
    const result = await createAgent({ provider: providers[0][1](server), tools: [add], instructions: 'x', retry: false }).send('go');

    expect(result.text).toBe('ok');
    expect(JSON.parse(toolResults(server)[0].content)).toMatchObject({ error: 'ToolNotFoundError', toolName: 'nope', kind: 'not-found' });
  });

  it('a tool that throws reaches the model as one tool error, on the chat and the stream path', async () => {
    const failing = defineTool({ ...add, execute: () => { throw new Error('disk full'); } });
    const server = await fakeServer((n, body) => {
      const first = n % 2 === 0;
      if (body.stream) return { sse: first ? [chunk([{ index: 0, delta: { tool_calls: [{ index: 0, ...call('c1', '{"a":1,"b":2}') }] }, finish_reason: 'tool_calls' }])] : textStream('ok') };
      return { json: first ? completion(null, 'tool_calls', [call('c1', '{"a":1,"b":2}')]) : completion('ok', 'stop') };
    });
    const agent = createAgent({ provider: providers[0][1](server), tools: [failing], instructions: 'x', retry: false });

    expect((await agent.send('go')).text).toBe('ok');
    expect((await agent.stream('go').result).text).toBe('ok');
    for (const n of [1, 3]) {
      const tool = ((server.requests[n].messages ?? []) as Array<{ role: string; content: string }>).find((m) => m.role === 'tool');
      const content = JSON.parse(tool?.content ?? '') as Record<string, unknown>;
      expect(content).toMatchObject({ message: expect.stringContaining('disk full') });
      expect(typeof content.error).toBe('string');
    }
  });
});

describe('the request a provider answers', () => {
  it('a file part the provider cannot send rejects send() with LOUSHO_UNSUPPORTED_CONTENT, sending nothing', async () => {
    const server = await fakeServer(() => ({ json: completion('ok', 'stop') }));
    const agent = createAgent({ provider: providers[0][1](server), instructions: 'x', retry: fast });
    const sheet = [{ type: 'file' as const, data: new Uint8Array([1, 2, 3]), mimeType: 'application/vnd.ms-excel', filename: 'a.xls' }];

    await expect(agent.send(sheet)).rejects.toMatchObject({ code: 'LOUSHO_UNSUPPORTED_CONTENT', message: expect.stringContaining('application/vnd.ms-excel') });
    await expect(agent.stream(sheet).result).rejects.toMatchObject({ code: 'LOUSHO_UNSUPPORTED_CONTENT' });
    expect(server.requests).toHaveLength(0);
  });

  it.each(providers)("a mid-stream error chunk keeps the upstream chunk as the error's responseBody: %s", async (_name, make) => {
    const upstream = { error: { message: 'Context size has been exceeded.' } };
    const server = await fakeServer(() => ({ sse: [upstream] }));
    const error = await createAgent({ provider: make(server), instructions: 'x', retry: fast }).stream('hi').result.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CompactedLLMProviderError);
    const compacted = error as CompactedLLMProviderError;
    expect(compacted.compacted).toMatchObject({ category: 'context-length-exceeded', retryable: false });
    expect(compacted.message).toMatch(/Context size has been exceeded/);
    expect(JSON.parse(String((compacted.cause as { responseBody?: string }).responseBody))).toEqual(upstream);
    expect(server.requests).toHaveLength(1);
  });

  it.each(providers)('a JSON reply to a streaming request keeps its text: send() with onEvent and stream(): %s', async (_name, make) => {
    const server = await fakeServer(() => ({ json: completion('hello there', 'stop') }));
    const agent = createAgent({ provider: make(server), instructions: 'x', retry: false });
    const deltas: string[] = [];

    const sent = await agent.send('hi', { onEvent: (event) => { if (event.type === 'text.delta') deltas.push(event.text); } });
    const streamed = await agent.stream('hi').result;

    expect(server.requests.every((body) => body.stream === true)).toBe(true);
    expect(sent).toMatchObject({ text: 'hello there', finishReason: 'stop' });
    expect(deltas.join('')).toBe('hello there');
    expect(streamed).toMatchObject({ text: 'hello there', finishReason: 'stop' });
    expect(streamed.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it('a JSON reply with tool calls to a streaming request runs the tools', async () => {
    const add = defineTool({ name: 'add', description: 'Adds', input: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => ({ sum: a + b }) });
    const toolCall = { id: 'c1', type: 'function', function: { name: 'add', arguments: '{"a":1,"b":2}' } };
    const server = await fakeServer((n) => ({ json: n === 0 ? completion(null, 'tool_calls', [toolCall]) : completion('3', 'stop') }));

    const result = await createAgent({ provider: providers[0][1](server), tools: [add], instructions: 'x', retry: false }).stream('1+2?').result;

    expect(result.text).toBe('3');
    const tool = ((server.requests[1].messages ?? []) as Array<{ role: string; content: string }>).find((m) => m.role === 'tool');
    expect(JSON.parse(tool?.content ?? '')).toEqual({ sum: 3 });
  });
});
