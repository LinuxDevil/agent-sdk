/**
 * `ollama-ai-provider-v2` on `ai` 6/7, for real (LOU-M8): the first test that loads the actual
 * package. A local `node:http` server answers Ollama's `/api/chat` (one non-streamed reply, one
 * streamed NDJSON reply, one tool-call turn), and `OllamaProvider` is pointed at it. It runs only
 * where the package resolves (the `ai6-zod4` and `ai7-zod4` CI jobs; it needs zod 4) and skips
 * everywhere else, including on `ai` 4, which uses `ollama-ai-provider`.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { installedAiMajor, ollamaV2Installed } from './aiMajor.testkit';
import { OllamaProvider } from './OllamaProvider';

interface ChatBody {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content?: string; tool_calls?: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

/** What the fake Ollama saw, and what it answers for the next request. */
const requests: ChatBody[] = [];
let answer: (body: ChatBody) => object[] = () => [];

const usage = { prompt_eval_count: 11, eval_count: 5 };
const base = { model: 'llama3.1', created_at: '2026-01-01T00:00:00Z' };

async function readJson(req: IncomingMessage): Promise<ChatBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatBody;
}

let server: Server;
let baseURL = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    void readJson(req).then((body) => {
      requests.push(body);
      const lines = answer(body);
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(lines[0]));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
});

const lookup = defineTool({
  name: 'get_weather',
  description: 'Weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

/** Turn 1 asks for the tool; once a tool result is in the conversation, turn 2 answers. */
function toolLoop(body: ChatBody): object[] {
  if (body.messages.some((m) => m.role === 'tool')) {
    return [{ ...base, message: { role: 'assistant', content: 'Paris is 21C.' }, done: true, done_reason: 'stop', ...usage }];
  }
  return [
    {
      ...base,
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }] },
      done: true,
      done_reason: 'stop',
      ...usage,
    },
  ];
}

const messages = [{ role: 'user' as const, content: 'hi' }];

describe.skipIf(!ollamaV2Installed || installedAiMajor === 4)('ollama-ai-provider-v2 against a fake Ollama server', () => {
  function provider(): OllamaProvider {
    return new OllamaProvider({ name: 'ollama', baseURL, maxRetries: 0 });
  }

  it('generate(): a non-streamed reply, with usage', async () => {
    answer = () => [{ ...base, message: { role: 'assistant', content: 'Hello there.' }, done: true, done_reason: 'stop', ...usage }];

    const result = await provider().generate({ messages });

    expect(result.text).toBe('Hello there.');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toMatchObject({ promptTokens: 11, completionTokens: 5 });
    expect(requests[0]).toMatchObject({ model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }] });
  });

  it('stream(): NDJSON chunks arrive as text deltas', async () => {
    answer = () => [
      { ...base, message: { role: 'assistant', content: 'Hello ' }, done: false },
      { ...base, message: { role: 'assistant', content: 'there.' }, done: false },
      { ...base, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', ...usage },
    ];

    const result = await provider().stream({ messages });
    const deltas: string[] = [];
    for await (const delta of result.textStream) deltas.push(delta);

    expect(deltas.join('')).toBe('Hello there.');
    expect(deltas.length).toBeGreaterThan(0);
    expect(await result.text).toBe('Hello there.');
    expect(requests[0]).toMatchObject({ stream: true });
  });

  it('createAgent().send(): a tool-call turn runs the tool and sends its result back', async () => {
    answer = toolLoop;

    const result = await createAgent({ provider: provider(), tools: [lookup], maxSteps: 3 }).send('Weather in Paris?');

    expect(result.text).toBe('Paris is 21C.');
    expect(requests).toHaveLength(2);
    expect(requests[0]!.tools?.map((t) => t.function.name)).toEqual(['get_weather']);
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool' });
    expect(requests[1]!.messages.at(-1)!.content).toContain('21');
  });

  it('createAgent().stream(): the same tool-call turn, streamed', async () => {
    answer = toolLoop;

    const run = createAgent({ provider: provider(), tools: [lookup], maxSteps: 3 }).stream('Weather in Paris?');
    const types: string[] = [];
    for await (const event of run) types.push(event.type);

    expect(types).toEqual(expect.arrayContaining(['tool.start', 'tool.done', 'text.delta', 'run.done']));
    expect((await run.result).text).toBe('Paris is 21C.');
  });
});
