/**
 * LOU-R12: `tools` accepts a record (the `connectMcp().tools` shape), an array
 * of named tools (`defineTool()` / `openApiTools()` / `createFsTools()`), and
 * arrays mixing tools and records.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { defineTool } from './defineTool';
import { toolEntries } from './toolEntries';
import { ToolRegistry } from './ToolRegistry';
import { loadMcpTools } from './mcp/McpToolLoader';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { Message } from '../providers';

const weather = () =>
  defineTool({
    name: 'weather',
    description: 'Weather of a city',
    input: z.object({ city: z.string() }),
    execute: async ({ city }) => `sunny in ${city}`,
  });

function fakeMcpClient(callTool: Client['callTool']): Client {
  return {
    listTools: async () => ({ tools: [{ name: 'search', description: 'Search the docs', inputSchema: { type: 'object' } }] }),
    callTool,
  } as unknown as Client;
}

const mcpTools = () => loadMcpTools(fakeMcpClient(async () => ({ content: [{ type: 'text', text: 'found it' }] })), 'srv', { approval: 'never' });

function toolResults(messages: readonly Message[]): string[] {
  return messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
}

describe('toolEntries (LOU-R12)', () => {
  it('flattens a record to [name, tool] entries', () => {
    const tool = weather();
    expect(toolEntries({ weather: tool }, 'test')).toEqual([['weather', tool]]);
  });

  it('flattens an array of named tools by their own name', () => {
    const tool = weather();
    expect(toolEntries([tool], 'test')).toEqual([['weather', tool]]);
  });

  it('flattens an array mixing tools and records (the connectMcp() shape)', async () => {
    const tool = weather();
    const mcp = await mcpTools();
    const entries = toolEntries([mcp, tool], 'test');
    expect(entries.map(([name]) => name)).toEqual(['srv__search', 'weather']);
    expect(entries[0][1]).toBe(mcp.srv__search);
  });

  it('names a descriptor by its own `name` (what loadMcpTools sets)', async () => {
    const mcp = await mcpTools();
    expect(toolEntries(Object.values(mcp), 'test').map(([name]) => name)).toEqual(['srv__search']);
  });

  it('rejects a duplicate name across an array and a record', () => {
    expect(() => toolEntries([weather(), { weather: weather() }], 'test')).toThrow(/two entries.*'weather'/);
  });

  it('rejects an unnamed descriptor in an array, pointing at the record form', () => {
    const { name: _name, ...descriptor } = weather();
    expect(() => toolEntries([descriptor as never], 'test')).toThrow(/no 'name'.*record form/);
  });

  it('rejects an array entry that is neither tool nor record', () => {
    expect(() => toolEntries(['weather' as never], 'test')).toThrow(/must be a tool or a record of tools/);
    expect(() => toolEntries([[weather()] as never], 'test')).toThrow(/must be a tool or a record of tools/);
  });

  it('treats undefined as no tools', () => {
    expect(toolEntries(undefined, 'test')).toEqual([]);
  });
});

describe('ToolRegistry.registerMany (LOU-R12)', () => {
  it('registers a mix of records and defined tools', async () => {
    const registry = new ToolRegistry();
    const mcp = await mcpTools();
    registry.registerMany([mcp, weather()]);
    expect(registry.list().sort()).toEqual(['srv__search', 'weather']);
    expect(registry.get('srv__search')).toBe(mcp.srv__search);
  });

  it('rejects hosted tools (they run on the provider, not the registry)', () => {
    const registry = new ToolRegistry();
    expect(() => registry.registerMany({ web_search: { kind: 'hosted-tool', name: 'web_search', type: 'web_search', options: {} } })).toThrow(
      /hosted tool/
    );
  });
});

describe('createAgent({ tools }) mixed shapes (LOU-R12)', () => {
  const calls = [{ name: 'srv__search', args: {}, id: 'c1' }, { name: 'weather', args: { city: 'Paris' }, id: 'c2' }];

  it('an MCP-style record and array tools side by side both run', async () => {
    const agent = createAgent({
      provider: mockModel([{ toolCalls: calls }, 'done']),
      tools: [await mcpTools(), weather()],
    });
    const result = await agent.send('Search the docs and check Paris.');
    expect(result.text).toBe('done');
    expect(toolResults(result.messages)).toHaveLength(2);
    expect(toolResults(result.messages).join('\n')).toContain('found it');
    expect(toolResults(result.messages).join('\n')).toContain('sunny in Paris');
  });

  it('an MCP-style record spread into the array works the same', async () => {
    const agent = createAgent({
      provider: mockModel([{ toolCalls: calls }, 'done']),
      tools: [...Object.values(await mcpTools()), weather()],
    });
    const result = await agent.send('Search the docs and check Paris.');
    expect(result.text).toBe('done');
    expect(toolResults(result.messages)).toHaveLength(2);
  });

  it('the plain record form still works', async () => {
    const agent = createAgent({
      provider: mockModel([{ toolCalls: calls }, 'done']),
      tools: { ...(await mcpTools()), weather: weather() },
    });
    const result = await agent.send('Search the docs and check Paris.');
    expect(result.text).toBe('done');
    expect(toolResults(result.messages)).toHaveLength(2);
  });

  it('a duplicate name across a record and a tool is a clear error, not a silent overwrite', async () => {
    const weatherRecord = { weather: weather() };
    await expect(async () => createAgent({ provider: mockModel(['x']), tools: [weatherRecord, weather()] })).rejects.toThrow(
      /two entries.*'weather'/
    );
  });

  it('a hosted tool inside a record entry is split out like a top-level one', async () => {
    const agent = createAgent({
      provider: mockModel(['ok']),
      tools: [{ docs: { kind: 'hosted-tool', name: 'docs', type: 'custom', options: {} } as never }, weather()],
    });
    const result = await agent.send('hi');
    expect(result.text).toBe('ok');
  });

  it('hosted tool under a mismatched record key keeps the naming error', () => {
    const hosted = { kind: 'hosted-tool', name: 'web_search', type: 'web_search', options: {} } as const;
    expect(() =>
      createAgent({ provider: mockModel(['x']), tools: [{ wrong_key: hosted } as never, weather()] })
    ).toThrow(/use 'web_search' as its key/);
  });
});
