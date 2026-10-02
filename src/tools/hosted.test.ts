/**
 * N1a: the hosted tool helpers, `isHostedTool`, the duplicate-name error, and
 * how `createAgent()` separates hosted tools from local ones (array and
 * record forms), checked through the requests `mockModel` records.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { codeInterpreter, fileSearch, hostedTool, isHostedTool, webSearch, assertHostedToolNames } from './hosted';
import { defineTool } from './defineTool';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing/mockModel';
import { AgentExecutor } from '../execution/AgentExecutor';
import { AgentBuilder } from '../core/AgentBuilder';
import type { LLMProvider } from '../providers';

const lookup = defineTool({
  name: 'lookup',
  description: 'Look a word up',
  input: z.object({ word: z.string() }),
  execute: async ({ word }) => ({ word }),
});

describe('hosted tool helpers', () => {
  it('webSearch() keeps the given options under the type as name', () => {
    const tool = webSearch({ searchContextSize: 'low', allowedDomains: ['example.com'], maxUses: undefined });
    expect(tool).toEqual({
      kind: 'hosted-tool',
      name: 'web_search',
      type: 'web_search',
      options: { searchContextSize: 'low', allowedDomains: ['example.com'] },
    });
    expect(webSearch().options).toEqual({});
  });

  it('codeInterpreter() and fileSearch()', () => {
    expect(codeInterpreter({ container: 'cntr_1' })).toMatchObject({ name: 'code_interpreter', type: 'code_interpreter', options: { container: 'cntr_1' } });
    expect(fileSearch({ vectorStoreIds: ['vs_1'], maxResults: 3 })).toMatchObject({
      name: 'file_search',
      type: 'file_search',
      options: { vectorStoreIds: ['vs_1'], maxResults: 3 },
    });
  });

  it('fileSearch() needs at least one vector store id', () => {
    expect(() => fileSearch({ vectorStoreIds: [] })).toThrow(/vectorStoreIds/);
  });

  it('hostedTool() passes an AI SDK tool object through under its name', () => {
    const aiSdkTool = { type: 'provider', id: 'openai.image_generation', args: {} };
    const tool = hostedTool('image_generation', aiSdkTool);
    expect(tool).toMatchObject({ kind: 'hosted-tool', name: 'image_generation', type: 'custom', options: {} });
    expect(tool.aiSdkTool).toBe(aiSdkTool);
    expect(() => hostedTool('', aiSdkTool)).toThrow(/non-empty/);
    expect(() => hostedTool('x', 'not a tool')).toThrow(/provider tool object/);
  });

  it('isHostedTool() tells hosted tools from everything else', () => {
    expect(isHostedTool(webSearch())).toBe(true);
    expect(isHostedTool(lookup)).toBe(false);
    expect(isHostedTool(null)).toBe(false);
    expect(isHostedTool({ kind: 'other' })).toBe(false);
  });

  it('a name used twice is a configuration error worded like the ToolRegistry one', () => {
    expect(() => assertHostedToolNames([webSearch(), webSearch()], [])).toThrow(
      "Tool name 'web_search' is already registered: another hosted tool conflicts with hosted tool 'web_search' (web_search). Give one of them a different name."
    );
    expect(() => assertHostedToolNames([hostedTool('lookup', {})], ['lookup'])).toThrow(/a local tool conflicts with hosted tool 'lookup'/);
  });
});

describe('createAgent() separates hosted tools', () => {
  it('array form: the hosted tool goes to the provider, the local tool to the registry', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'lookup', args: { word: 'a' } }] }, 'done']);
    const agent = createAgent({ provider: model, instructions: 'x', tools: [webSearch(), lookup] });
    const result = await agent.send('hi');
    expect(result.text).toBe('done');
    expect(model.calls[0]!.hostedTools?.map((tool) => tool.name)).toEqual(['web_search']);
    expect(model.calls[0]!.tools?.map((tool) => tool.function.name)).toEqual(['lookup']);
    expect(model.calls[1]!.hostedTools?.map((tool) => tool.name)).toEqual(['web_search']);
  });

  it('record form: a hosted tool under its own name', async () => {
    const model = mockModel(['ok']);
    const agent = createAgent({ provider: model, instructions: 'x', tools: { web_search: webSearch(), lookup } });
    await agent.send('hi');
    expect(model.calls[0]!.hostedTools?.map((tool) => tool.type)).toEqual(['web_search']);
    expect(model.calls[0]!.tools?.map((tool) => tool.function.name)).toEqual(['lookup']);
  });

  it('record form: a hosted tool under another key is a configuration error', () => {
    expect(() => createAgent({ provider: mockModel([]), instructions: 'x', tools: { search: webSearch() } })).toThrow(/under the key 'search'/);
  });

  it('a hosted tool named like a local tool fails at creation', () => {
    expect(() => createAgent({ provider: mockModel([]), instructions: 'x', tools: [hostedTool('lookup', {}), lookup] })).toThrow(
      /Tool name 'lookup' is already registered/
    );
  });

  it('a tools function picks hosted tools per run', async () => {
    const model = mockModel(['a', 'b']);
    const agent = createAgent({
      provider: model,
      instructions: 'x',
      tools: ({ metadata }) => (metadata?.search ? [webSearch()] : []),
    });
    await agent.send('one', { metadata: { search: true } });
    await agent.send('two');
    expect(model.calls[0]!.hostedTools?.map((tool) => tool.name)).toEqual(['web_search']);
    expect(model.calls[1]!.hostedTools).toBeUndefined();
  });
});

describe('AgentExecutor checks hosted tool support', () => {
  const agent = AgentBuilder.create().setName('a').setPrompt('x').build();

  it('a custom LLMProvider without supportsHostedTool() is LOUSHO_HOSTED_TOOL_UNSUPPORTED', async () => {
    const provider: LLMProvider = {
      name: 'custom',
      generate: async () => ({ text: 'never', finishReason: 'stop' }),
      stream: async () => {
        throw new Error('unused');
      },
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => [],
    };
    await expect(AgentExecutor.execute({ agent, provider, input: 'hi', hostedTools: [webSearch()] })).rejects.toMatchObject({
      code: 'LOUSHO_HOSTED_TOOL_UNSUPPORTED',
      message: expect.stringContaining("The 'custom' provider cannot run hosted tool 'web_search' (web_search)"),
    });
  });

  it('a provider that reports no support for the type is rejected; one that does is called', async () => {
    const calls: unknown[] = [];
    const provider: LLMProvider = {
      name: 'picky',
      generate: async (options) => {
        calls.push(options.hostedTools);
        return { text: 'ok', finishReason: 'stop' };
      },
      stream: async () => {
        throw new Error('unused');
      },
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => [],
      supportsHostedTool: (type) => type === 'web_search',
    };
    await expect(AgentExecutor.execute({ agent, provider, input: 'hi', hostedTools: [codeInterpreter()] })).rejects.toMatchObject({
      code: 'LOUSHO_HOSTED_TOOL_UNSUPPORTED',
    });
    expect(calls).toEqual([]);
    const result = await AgentExecutor.execute({ agent, provider, input: 'hi', hostedTools: [webSearch()] });
    expect(result.text).toBe('ok');
    expect(calls).toHaveLength(1);
  });
});
