/**
 * N1b: hosted tools on the Anthropic provider, with a stubbed
 * `@ai-sdk/anthropic` whose `tools` object has the dated factories the test
 * chooses, and scripted `MockLanguageModelV4` results and streams on `ai` v7
 * (the `ai-v7` dev alias). Covers the factory choice (newest dated name
 * first), the option mapping, the unsupported cases, and an agent run over
 * Anthropic-shaped provider-executed `web_search` parts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as aiV7 from 'ai-v7';
import { MockLanguageModelV4 } from 'ai-v7/test';
import { AnthropicProvider } from './AnthropicProvider';
import type { AiSdkModule } from './aiSdkCompat';
import { codeInterpreter, fileSearch, webSearch } from '../tools/hosted';
import { createAgent } from '../createAgent';
import type { AgentEvent } from '../execution/agentEvents';

type V7Stream = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'];
type V7Part = V7Stream extends ReadableStream<infer P> ? P : never;
type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];

/** A provider tool object as `@ai-sdk/anthropic` 4 builds it. */
function providerTool(id: string, args: Record<string, unknown>) {
  return { type: 'provider' as const, id, args, inputSchema: aiV7.jsonSchema({ type: 'object', properties: {} }) };
}

/** The `tools` of the stubbed `@ai-sdk/anthropic`: a test sets which dated factories exist. */
let anthropicTools: Record<string, unknown> = {};

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => Object.assign(() => ({}), { get tools() { return anthropicTools; } }),
}));

const factory = (id: string) => vi.fn((args: Record<string, unknown>) => providerTool(id, args));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** One step as Anthropic reports it: a provider-executed `web_search`, its result, a cited source, the answer. */
const SEARCH_INPUT = '{"query":"node 24 release"}';
const SEARCH_RESULT = [{ type: 'web_search_result', url: 'https://nodejs.org', title: 'Node.js' }];

function searchStreamParts(): V7Part[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'srvtoolu_1', toolName: 'web_search', providerExecuted: true },
    { type: 'tool-input-end', id: 'srvtoolu_1' },
    { type: 'tool-call', toolCallId: 'srvtoolu_1', toolName: 'web_search', input: SEARCH_INPUT, providerExecuted: true },
    { type: 'tool-result', toolCallId: 'srvtoolu_1', toolName: 'web_search', result: SEARCH_RESULT },
    { type: 'source', sourceType: 'url', id: 's1', url: 'https://nodejs.org', title: 'Node.js' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Node 24 is current.' },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage },
  ];
}

function scripted() {
  const calls: CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      return { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'end_turn' }, usage, warnings: [] };
    },
    doStream: async (options) => {
      calls.push(options);
      return {
        stream: new ReadableStream<V7Part>({
          start(controller) {
            for (const part of searchStreamParts()) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
  return { calls, model };
}

/** An Anthropic provider on `ai` v7 calling `model`. */
function anthropicOnV7(model: MockLanguageModelV4): AnthropicProvider {
  const provider = new AnthropicProvider({ name: 'anthropic', apiKey: 'k', maxRetries: 0, defaultModel: 'claude-sonnet-4-5' });
  Object.assign(provider, { ai: aiV7 as AiSdkModule });
  vi.spyOn(provider as unknown as { createModel: () => Promise<unknown> }, 'createModel').mockResolvedValue(model);
  return provider;
}

const hi = [{ role: 'user' as const, content: 'hi' }];

beforeEach(() => {
  anthropicTools = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AnthropicProvider hosted tool factories (stubbed @ai-sdk/anthropic)', () => {
  it('web_search uses the newest webSearch_* the package exports, keyed web_search', async () => {
    const old = factory('anthropic.web_search_20250305');
    const newest = factory('anthropic.web_search_20260318');
    const middle = factory('anthropic.web_search_20260209');
    anthropicTools = { webSearch_20250305: old, webSearch_20260318: newest, webSearch_20260209: middle };
    const { calls, model } = scripted();
    await anthropicOnV7(model).generate({ messages: hi, hostedTools: [webSearch()] });
    expect(newest).toHaveBeenCalledTimes(1);
    expect(old).not.toHaveBeenCalled();
    expect(middle).not.toHaveBeenCalled();
    expect(calls[0]!.tools?.map((tool) => [tool.type, tool.name, 'id' in tool ? tool.id : undefined])).toEqual([
      ['provider', 'web_search', 'anthropic.web_search_20260318'],
    ]);
  });

  it('falls back to an older package that only has webSearch_20250305', async () => {
    const only = factory('anthropic.web_search_20250305');
    anthropicTools = { webSearch_20250305: only, codeExecution_20250522: factory('anthropic.code_execution_20250522') };
    await anthropicOnV7(scripted().model).generate({ messages: hi, hostedTools: [webSearch()] });
    expect(only).toHaveBeenCalledTimes(1);
  });

  it('code_interpreter uses the newest codeExecution_*, and keeps our name', async () => {
    const old = factory('anthropic.code_execution_20250522');
    const newest = factory('anthropic.code_execution_20260120');
    anthropicTools = { codeExecution_20250522: old, codeExecution_20250825: factory('x'), codeExecution_20260120: newest };
    const { calls, model } = scripted();
    await anthropicOnV7(model).generate({ messages: hi, hostedTools: [codeInterpreter()] });
    expect(newest).toHaveBeenCalledWith({});
    expect(old).not.toHaveBeenCalled();
    expect(calls[0]!.tools?.map((tool) => tool.name)).toEqual(['code_interpreter']);
  });

  it('maps maxUses, allowedDomains, blockedDomains and userLocation; warns once about searchContextSize', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const search = factory('anthropic.web_search_20260318');
    anthropicTools = { webSearch_20260318: search };
    const provider = anthropicOnV7(scripted().model);
    const tool = webSearch({ maxUses: 2, allowedDomains: ['nodejs.org'], blockedDomains: ['x.com'], userLocation: { country: 'DE', city: 'Berlin' }, searchContextSize: 'high' });
    await provider.generate({ messages: hi, hostedTools: [tool] });
    await provider.generate({ messages: hi, hostedTools: [tool] });
    expect(search).toHaveBeenCalledWith({
      maxUses: 2,
      allowedDomains: ['nodejs.org'],
      blockedDomains: ['x.com'],
      userLocation: { type: 'approximate', country: 'DE', city: 'Berlin' },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("Anthropic's web_search tool does not take searchContextSize");
  });

  it('file_search is LOUSHO_HOSTED_TOOL_UNSUPPORTED: Anthropic has no hosted file search', async () => {
    anthropicTools = { webSearch_20260318: factory('x') };
    const provider = anthropicOnV7(scripted().model);
    expect(provider.supportsHostedTool('file_search')).toBe(false);
    await expect(provider.generate({ messages: hi, hostedTools: [fileSearch({ vectorStoreIds: ['vs_1'] })] })).rejects.toMatchObject({
      code: 'LOUSHO_HOSTED_TOOL_UNSUPPORTED',
      message: expect.stringContaining('Anthropic has no hosted file search'),
    });
  });

  it('a package with neither factory is LOUSHO_HOSTED_TOOL_UNSUPPORTED, naming what is needed', async () => {
    anthropicTools = { webFetch_20260318: factory('x'), webSearch_latest: factory('y') };
    const provider = anthropicOnV7(scripted().model);
    for (const tool of [webSearch(), codeInterpreter()]) {
      await expect(provider.generate({ messages: hi, hostedTools: [tool] })).rejects.toMatchObject({
        code: 'LOUSHO_HOSTED_TOOL_UNSUPPORTED',
        message: expect.stringContaining('@ai-sdk/anthropic 3 with ai 6, or 4 with ai 7'),
      });
    }
  });

  it('supportsHostedTool: web_search, code_interpreter and custom on ai 6 or 7; nothing on ai 4', () => {
    const provider = anthropicOnV7(scripted().model);
    expect(['web_search', 'code_interpreter', 'custom', 'file_search'].map((type) => provider.supportsHostedTool(type as 'custom'))).toEqual([true, true, true, false]);
    Object.assign(provider, { ai: { generateText: vi.fn(), streamText: vi.fn(), jsonSchema: (schema: never) => schema } });
    expect(provider.supportsHostedTool('web_search')).toBe(false);
  });

  it('ai 4 refuses every hosted tool', async () => {
    const provider = anthropicOnV7(scripted().model);
    Object.assign(provider, { ai: { generateText: vi.fn(), streamText: vi.fn(), jsonSchema: (schema: never) => schema } });
    await expect(provider.generate({ messages: hi, hostedTools: [webSearch()] })).rejects.toMatchObject({
      code: 'LOUSHO_HOSTED_TOOL_UNSUPPORTED',
      message: expect.stringContaining('hosted tools need ai 6 or 7, and ai 4 is installed'),
    });
  });
});

describe('an agent run over Anthropic-shaped provider-executed parts (ai 7)', () => {
  it('streams tool.start / tool.done with executedBy provider, sources and usage', async () => {
    anthropicTools = { webSearch_20260318: factory('anthropic.web_search_20260318') };
    const events: AgentEvent[] = [];
    const agent = createAgent({ provider: anthropicOnV7(scripted().model), instructions: 'x', tools: [webSearch({ maxUses: 1 })], onEvent: (event) => events.push(event) });
    const result = await agent.send('What is the latest Node?');
    const tools = events.filter((event) => event.type.startsWith('tool.'));
    expect(tools.map((event) => [event.type, 'executedBy' in event ? event.executedBy : undefined])).toEqual([
      ['tool.start', 'provider'],
      ['tool.done', 'provider'],
    ]);
    expect(tools[0]).toMatchObject({ toolCallId: 'srvtoolu_1', toolName: 'web_search', args: { query: 'node 24 release' } });
    expect(result.messages.at(-1)!.metadata?.hostedToolCalls).toEqual([
      { id: 'srvtoolu_1', name: 'web_search', args: { query: 'node 24 release' }, result: SEARCH_RESULT, sources: [{ url: 'https://nodejs.org', title: 'Node.js' }] },
    ]);
    expect(result.usage.hostedToolCalls).toEqual({ web_search: 1 });
    expect(result.text).toBe('Node 24 is current.');
  });
});
