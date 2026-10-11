/**
 * Cost and `limits.maxCostUsd` for an Ollama model (`llama3`, the env default),
 * through the real Ollama package (`ollama-ai-provider` on `ai` 4,
 * `ollama-ai-provider-v2` where it is installed) against a local `/api/chat`.
 * Local models have no built-in price: the cost is unknown and the limit is
 * only warned about, until a price is registered for the model.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { getModelInfo, registerModel } from '../models/registry';
import { installedAiMajor, ollamaV2Installed } from './aiMajor.testkit';
import { OllamaProvider } from './OllamaProvider';

/** Ollama's `/api/chat` reply: a call to `now` first, then the answer once a tool result is in the conversation. */
const reply = (body: string) => ({
  model: 'llama3',
  created_at: '2026-01-01T00:00:00Z',
  message: (JSON.parse(body) as { messages: Array<{ role: string }> }).messages.some((m) => m.role === 'tool')
    ? { role: 'assistant', content: 'It is noon.' }
    : { role: 'assistant', content: '', tool_calls: [{ function: { name: 'now', arguments: {} } }] },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 1000,
  eval_count: 500,
  total_duration: 1,
  load_duration: 1,
  prompt_eval_duration: 1,
  eval_duration: 1,
});

let server: Server;
let baseURL = '';
const paths: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      paths.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const builtIn = getModelInfo('llama3');

afterEach(() => {
  toolRuns = 0;
  if (builtIn) registerModel(builtIn);
  vi.restoreAllMocks();
});

let toolRuns = 0;
const now = defineTool({ name: 'now', description: 'The time', input: z.object({}), execute: () => (toolRuns++, { time: '12:00' }) });

const agent = (maxCostUsd: number) =>
  createAgent({
    provider: new OllamaProvider({ baseURL, defaultModel: 'llama3' }),
    instructions: 'x',
    tools: [now],
    limits: { maxCostUsd },
    retry: false,
  });

describe.skipIf(installedAiMajor !== 4 && !ollamaV2Installed)('Ollama llama3 cost and maxCostUsd', () => {
  it('llama3 is a known model with no built-in price: the cost is unknown and maxCostUsd warns instead of stopping', async () => {
    expect(builtIn).toMatchObject({ provider: 'ollama', contextWindow: 8192 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await agent(0.000001).send('hi');

    expect(paths.at(-1)).toBe('/api/chat');
    expect(result.text).toBe('It is noon.');
    expect(result.finishReason).toBe('stop');
    expect(toolRuns).toBe(1);
    expect(result.usage).toMatchObject({ inputTokens: 2000, outputTokens: 1000, modelCalls: 2, estimated: false });
    expect(result.usage.costUsd).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/maxCostUsd is set, but the cost of a model call is unknown/));
  });

  it('with a registered price, maxCostUsd is enforced on an Ollama run', async () => {
    registerModel({ id: 'llama3', provider: 'ollama', contextWindow: 8192, inputCostPerMTok: 1, outputCostPerMTok: 2 });

    const within = await agent(1).send('hi');
    // Two calls of (1000 * 1 + 500 * 2) / 1e6
    expect(within.usage.costUsd).toBeCloseTo(0.004, 10);
    expect(within.finishReason).toBe('stop');

    toolRuns = 0;
    const over = await agent(0.001).send('hi');
    expect(over.finishReason).toBe('budget-exceeded');
    expect(over.budget).toMatchObject({ limit: 'maxCostUsd', max: 0.001, scope: 'run' });
    expect(over.budget?.value).toBeCloseTo(0.002, 10);
    // Stopped after the first call, before its tool ran.
    expect(toolRuns).toBe(0);
  });

  it('a local model priced at 0 costs $0 and passes any cost limit', async () => {
    registerModel({ id: 'llama3', provider: 'ollama', contextWindow: 8192, inputCostPerMTok: 0, outputCostPerMTok: 0 });

    const result = await agent(0.000001).send('hi');

    expect(result.usage.costUsd).toBe(0);
    expect(result.finishReason).toBe('stop');
  });
});
