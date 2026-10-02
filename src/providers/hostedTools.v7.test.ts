/**
 * N1a: hosted provider tools on `ai` v7 (the `ai-v7` dev alias), with a
 * stubbed `@ai-sdk/openai` whose `tools.webSearch()` / `codeInterpreter()` /
 * `fileSearch()` build provider tool objects, and scripted
 * `MockLanguageModelV4` results and streams. Covers the request (the
 * provider tool is sent as it is), the stream and `generate()` mapping
 * (provider-executed calls become hosted calls, never local tool calls), an
 * agent run over both paths, and the unsupported pairings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as aiV7 from 'ai-v7';
import { MockLanguageModelV4 } from 'ai-v7/test';
import { z } from 'zod';
import { OpenAIProvider } from './OpenAIProvider';
import { OllamaProvider } from './OllamaProvider';
import { createFromAiSdk } from './fromAiSdk';
import type { LLMProvider, StreamChunk } from './llm';
import type { AiSdkModule } from './aiSdkCompat';
import { codeInterpreter, fileSearch, hostedTool, webSearch } from '../tools/hosted';
import { defineTool } from '../tools/defineTool';
import { createAgent } from '../createAgent';
import { AgentExecutor } from '../execution/AgentExecutor';
import type { AgentEvent } from '../execution/agentEvents';
import type { LanguageModel } from 'ai';

type V7Stream = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'];
type V7Part = V7Stream extends ReadableStream<infer P> ? P : never;
type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type ModelResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

/** A provider tool object as `@ai-sdk/openai` 4 builds it (an `ai` 7 `type: 'provider'` tool). */
function providerTool(id: string, args: Record<string, unknown>) {
  return { type: 'provider' as const, id, args, inputSchema: aiV7.jsonSchema({ type: 'object', properties: {} }) };
}

const factories = {
  webSearch: vi.fn((args: Record<string, unknown>) => providerTool('openai.web_search', args)),
  codeInterpreter: vi.fn((args: Record<string, unknown>) => providerTool('openai.code_interpreter', args)),
  fileSearch: vi.fn((args: Record<string, unknown>) => providerTool('openai.file_search', args)),
};

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => Object.assign(() => ({}), { tools: factories }),
}));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const SEARCH_RESULT = { action: { type: 'search', query: 'lousho sdk' }, status: 'completed' };

/** One step: a web search the provider ran, a source it cited, then the answer; the provider still says `tool-calls`. */
function searchStreamParts(isError = false): V7Part[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'ws_1', toolName: 'web_search', providerExecuted: true },
    { type: 'tool-input-end', id: 'ws_1' },
    { type: 'tool-call', toolCallId: 'ws_1', toolName: 'web_search', input: '{"query":"lousho sdk"}', providerExecuted: true },
    { type: 'tool-result', toolCallId: 'ws_1', toolName: 'web_search', result: isError ? 'search backend down' : SEARCH_RESULT, ...(isError && { isError: true }) },
    { type: 'source', sourceType: 'url', id: 's1', url: 'https://lousho.com', title: 'Lousho' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Lousho is ' },
    { type: 'text-delta', id: 't1', delta: 'an SDK.' },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ];
}

function searchResult(): ModelResult {
  return {
    content: [
      { type: 'tool-call', toolCallId: 'ws_1', toolName: 'web_search', input: '{"query":"lousho sdk"}', providerExecuted: true },
      { type: 'tool-result', toolCallId: 'ws_1', toolName: 'web_search', result: SEARCH_RESULT },
      { type: 'source', sourceType: 'url', id: 's1', url: 'https://lousho.com', title: 'Lousho' },
      { type: 'text', text: 'Lousho is an SDK.' },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage,
    warnings: [],
  };
}

function streamOf<P>(parts: P[]): ReadableStream<P> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

interface Scripted {
  calls: CallOptions[];
  model: MockLanguageModelV4;
}

/** A model that answers every call with `result()` / `parts()`. */
function scriptedModel(result: () => ModelResult = searchResult, parts: () => V7Part[] = () => searchStreamParts()): Scripted {
  const calls: CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      return result();
    },
    doStream: async (options) => {
      calls.push(options);
      return { stream: streamOf(parts()) };
    },
  });
  return { calls, model };
}

/** An OpenAI provider on `ai` v7 calling `model`. */
function openAIOnV7(model: MockLanguageModelV4): OpenAIProvider {
  const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k', maxRetries: 0, defaultModel: 'gpt-4o-mini' });
  Object.assign(provider, { ai: aiV7 as AiSdkModule });
  const target = provider as unknown as { createModel: (id: string) => Promise<unknown> };
  vi.spyOn(target, 'createModel').mockResolvedValue(model);
  return provider;
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

beforeEach(() => {
  for (const factory of Object.values(factories)) factory.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAIProvider maps the hosted helpers (stubbed @ai-sdk/openai)', () => {
  it('calls each factory with its option names and sends the provider tools under their keys', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { calls, model } = scriptedModel(() => ({ ...searchResult(), content: [{ type: 'text', text: 'ok' }] }));
    const provider = openAIOnV7(model);
    await provider.generate({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: {} } } }],
      hostedTools: [
        webSearch({ searchContextSize: 'low', allowedDomains: ['lousho.com'], userLocation: { country: 'DE' }, maxUses: 2, blockedDomains: ['x.com'] }),
        codeInterpreter({ container: 'cntr_1' }),
        fileSearch({ vectorStoreIds: ['vs_1'], maxResults: 4 }),
      ],
    });
    expect(factories.webSearch).toHaveBeenCalledWith({
      searchContextSize: 'low',
      filters: { allowedDomains: ['lousho.com'] },
      userLocation: { type: 'approximate', country: 'DE' },
    });
    expect(factories.codeInterpreter).toHaveBeenCalledWith({ container: 'cntr_1' });
    expect(factories.fileSearch).toHaveBeenCalledWith({ vectorStoreIds: ['vs_1'], maxNumResults: 4 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("OpenAI's web_search tool does not take maxUses, blockedDomains");

    const tools = calls[0]!.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(['lookup', 'web_search', 'code_interpreter', 'file_search']);
    expect(tools[1]).toEqual({
      type: 'provider',
      name: 'web_search',
      id: 'openai.web_search',
      args: { searchContextSize: 'low', filters: { allowedDomains: ['lousho.com'] }, userLocation: { type: 'approximate', country: 'DE' } },
    });
  });

  it('an @ai-sdk/openai without tools.webSearch is LOUSHO_HOSTED_TOOL_UNSUPPORTED', async () => {
    const provider = openAIOnV7(scriptedModel().model);
    const original = factories.webSearch;
    Object.assign(factories, { webSearch: undefined });
    try {
      await expect(provider.generate({ messages: [{ role: 'user', content: 'hi' }], hostedTools: [webSearch()] })).rejects.toMatchObject({
        code: 'LOUSHO_HOSTED_TOOL_UNSUPPORTED',
        message: expect.stringContaining('no tools.webSearch()'),
      });
    } finally {
      Object.assign(factories, { webSearch: original });
    }
  });
});

describe('provider-executed calls on ai 7', () => {
  it('stream(): hosted chunks with the result and its source, then the text; no local tool call', async () => {
    const provider = openAIOnV7(scriptedModel().model);
    const streamed = await provider.stream({ messages: [{ role: 'user', content: 'hi' }], hostedTools: [webSearch()] });
    const chunks = await collect(streamed.fullStream);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['hosted-tool-call', 'hosted-tool-result', 'text-delta', 'text-delta', 'finish']);
    expect(chunks[0]!.hostedToolCall).toMatchObject({ id: 'ws_1', name: 'web_search', args: { query: 'lousho sdk' } });
    expect(chunks[1]!.hostedToolCall).toEqual({
      id: 'ws_1',
      name: 'web_search',
      args: { query: 'lousho sdk' },
      result: SEARCH_RESULT,
      sources: [{ url: 'https://lousho.com', title: 'Lousho' }],
    });
    expect(await streamed.toolCalls).toEqual([]);
  });

  it('generate(): hostedToolCalls in call order, no toolCalls', async () => {
    const { calls, model } = scriptedModel();
    const provider = openAIOnV7(model);
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }], hostedTools: [webSearch()] });
    expect(calls[0]!.tools?.map((tool) => tool.type)).toEqual(['provider']);
    expect(result.text).toBe('Lousho is an SDK.');
    expect(result.toolCalls ?? []).toEqual([]);
    expect(result.hostedToolCalls).toEqual([
      { id: 'ws_1', name: 'web_search', args: { query: 'lousho sdk' }, result: SEARCH_RESULT, sources: [{ url: 'https://lousho.com', title: 'Lousho' }] },
    ]);
  });

  it('hostedTool() passes an AI SDK provider tool through on any AI SDK provider (fromAiSdk)', async () => {
    const { calls, model } = scriptedModel(() => ({ ...searchResult(), content: [{ type: 'text', text: 'ok' }] }));
    const provider = createFromAiSdk(model as unknown as LanguageModel, {}, aiV7 as AiSdkModule);
    expect(provider.supportsHostedTool?.('custom')).toBe(true);
    expect(provider.supportsHostedTool?.('web_search')).toBe(false);
    await provider.generate({ messages: [{ role: 'user', content: 'hi' }], hostedTools: [hostedTool('image_generation', providerTool('openai.image_generation', { size: 'auto' }))] });
    expect(calls[0]!.tools).toEqual([{ type: 'provider', name: 'image_generation', id: 'openai.image_generation', args: { size: 'auto' } }]);
  });
});

/** The agent's events, with a local tool that must never run. */
function agentOver(provider: LLMProvider) {
  const execute = vi.fn(async () => 'local');
  const lookup = defineTool({ name: 'lookup', description: 'Look up', input: z.object({}), execute });
  const events: AgentEvent[] = [];
  const agent = createAgent({ provider, instructions: 'x', tools: [webSearch(), lookup], onEvent: (event) => events.push(event) });
  return { agent, events, execute };
}

function expectHostedRun(events: AgentEvent[], result: { usage: { hostedToolCalls?: Partial<Record<string, number>> }; messages: Array<{ role: string; metadata?: Record<string, unknown> }>; finishReason: string }) {
  const tools = events.filter((event) => event.type.startsWith('tool.'));
  expect(tools.map((event) => [event.type, 'executedBy' in event ? event.executedBy : undefined])).toEqual([
    ['tool.start', 'provider'],
    ['tool.done', 'provider'],
  ]);
  expect(tools[0]).toMatchObject({ toolCallId: 'ws_1', toolName: 'web_search', args: { query: 'lousho sdk' } });
  expect(tools[1]).toMatchObject({ result: SEARCH_RESULT });
  const reply = result.messages.at(-1)!;
  expect(reply.role).toBe('assistant');
  expect(reply.metadata?.hostedToolCalls).toEqual([
    { id: 'ws_1', name: 'web_search', args: { query: 'lousho sdk' }, result: SEARCH_RESULT, sources: [{ url: 'https://lousho.com', title: 'Lousho' }] },
  ]);
  expect(result.usage.hostedToolCalls).toEqual({ web_search: 1 });
  // The provider said `tool-calls`, but no local call remains: a final reply.
  expect(result.finishReason).toBe('stop');
  const done = events.find((event) => event.type === 'run.done');
  expect(done).toMatchObject({ usage: { hostedToolCalls: { web_search: 1 } } });
}

describe('an agent run over provider-executed calls', () => {
  it('streamed (stream()): tool.start / tool.done with executedBy provider, no local tool, metadata and usage', async () => {
    const { calls, model } = scriptedModel();
    const { agent, events, execute } = agentOver(openAIOnV7(model));
    const run = agent.stream('What is lousho?');
    for await (const event of run) void event;
    const result = await run.result;
    expectHostedRun(events, result);
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    // The hosted call is not replayed as a tool call on a later model call.
    expect(result.messages.filter((m) => 'toolCalls' in m && m.toolCalls)).toEqual([]);
  });

  it('send() with a listener streams the call; the events are the same', async () => {
    const { model } = scriptedModel();
    const { agent, events, execute } = agentOver(openAIOnV7(model));
    expectHostedRun(events, await agent.send('What is lousho?'));
    expect(execute).not.toHaveBeenCalled();
  });

  it('a non-streamed step (generate()) reports the calls after it returns, in call order', async () => {
    const { model } = scriptedModel();
    const provider = openAIOnV7(model);
    vi.spyOn(provider, 'supportsStreaming').mockReturnValue(false);
    const { agent, events } = agentOver(provider);
    expectHostedRun(events, await agent.send('What is lousho?'));
    const order = events.filter((e) => e.type === 'tool.start' || e.type === 'tool.done' || e.type === 'text.delta').map((e) => e.type);
    expect(order).toEqual(['tool.start', 'tool.done', 'text.delta']);
  });

  it('a failed hosted call is tool.error with executedBy provider', async () => {
    const { model } = scriptedModel(searchResult, () => searchStreamParts(true));
    const { agent, events } = agentOver(openAIOnV7(model));
    await agent.send('What is lousho?');
    const failed = events.find((event) => event.type === 'tool.error');
    expect(failed).toMatchObject({ toolName: 'web_search', executedBy: 'provider', error: { name: 'HostedToolError', message: 'search backend down' } });
  });

  it('regression: a providerExecuted call never reaches runToolCalls()', async () => {
    const runToolCalls = vi.spyOn(AgentExecutor as unknown as { runToolCalls: () => Promise<undefined> }, 'runToolCalls');
    const { model } = scriptedModel();
    const result = await createAgent({ provider: openAIOnV7(model), instructions: 'x', tools: [webSearch()] }).send('hi');
    expect(runToolCalls).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe('Lousho is an SDK.');
  });
});

describe('unsupported pairings are LOUSHO_HOSTED_TOOL_UNSUPPORTED', () => {
  it('ai 4: every hosted tool, with the reason', async () => {
    const v4: AiSdkModule = { generateText: vi.fn(), streamText: vi.fn(), jsonSchema: (schema: never) => schema };
    const provider = new OpenAIProvider({ name: 'openai', apiKey: 'k', maxRetries: 0 });
    Object.assign(provider, { ai: v4 });
    vi.spyOn(provider as unknown as { createModel: () => Promise<unknown> }, 'createModel').mockResolvedValue({});
    expect(provider.supportsHostedTool('web_search')).toBe(false);
    await expect(provider.generate({ messages: [{ role: 'user', content: 'hi' }], hostedTools: [webSearch()] })).rejects.toMatchObject({
      code: 'LOUSHO_HOSTED_TOOL_UNSUPPORTED',
      message: expect.stringContaining('hosted tools need ai 6 or 7, and ai 4 is installed'),
    });
    expect(v4.generateText).not.toHaveBeenCalled();
    // Through an agent the executor refuses before any model call.
    await expect(createAgent({ provider, instructions: 'x', tools: [webSearch()] }).send('hi')).rejects.toMatchObject({ code: 'LOUSHO_HOSTED_TOOL_UNSUPPORTED' });
  });

  it('Ollama on ai 7: no built-in hosted tools', async () => {
    const provider = new OllamaProvider({ name: 'ollama', maxRetries: 0 });
    Object.assign(provider, { ai: aiV7 as AiSdkModule });
    vi.spyOn(provider as unknown as { createModel: () => Promise<unknown> }, 'createModel').mockResolvedValue(scriptedModel().model);
    expect(provider.supportsHostedTool('web_search')).toBe(false);
    await expect(provider.generate({ messages: [{ role: 'user', content: 'hi' }], hostedTools: [webSearch()] })).rejects.toMatchObject({
      code: 'LOUSHO_HOSTED_TOOL_UNSUPPORTED',
      message: expect.stringContaining("The 'ollama' provider cannot run hosted tool 'web_search'"),
    });
    await expect(createAgent({ provider, instructions: 'x', tools: [webSearch()] }).send('hi')).rejects.toMatchObject({ code: 'LOUSHO_HOSTED_TOOL_UNSUPPORTED' });
  });
});
