import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AgentExecutor } from '../../execution/AgentExecutor';
import { AgentBuilder } from '../../core';
import { mockModel } from '../../testing';
import { ToolRegistry } from '..';
import { loadMcpTools } from './McpToolLoader';
import { McpToolError } from './result';

/** A fake MCP client exposing one tool whose call returns `callResult`. */
function fakeClient(callResult: unknown, inputSchema: unknown = { type: 'object' }) {
  return {
    listTools: async () => ({ tools: [{ name: 'do_it', description: 'Do it', inputSchema }] }),
    callTool: vi.fn(async () => callResult),
  } as unknown as Client;
}

async function run(callResult: unknown) {
  const tools = await loadMcpTools(fakeClient(callResult), 'srv');
  return tools['srv__do_it'].tool.execute!({}, {} as never);
}

describe('MCP result handling (LOU-Z2)', () => {
  it('joins text parts; with only text the parts stay readable but are not serialized twice (audit D4)', async () => {
    const result = (await run({
      content: [
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ],
    })) as { text: string; content: unknown[] };
    expect(result.text).toBe('line 1\nline 2');
    expect(result.content).toEqual([
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
    ]);
    expect(JSON.stringify(result)).toBe('{"text":"line 1\\nline 2"}');
  });

  it('sends a text-only result to the model once, not twice (audit D4)', async () => {
    const payload = JSON.stringify({ usage: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [String(i), i * 1000])) });
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerMany(await loadMcpTools(fakeClient({ content: [{ type: 'text', text: payload }] }), 'srv', { approval: 'never' }));
    const agent = AgentBuilder.create().setName('t').addTool('srv__do_it', { tool: 'srv__do_it', options: {} }).build();
    const provider = mockModel([{ toolCalls: [{ name: 'srv__do_it' }] }, 'done']);
    await AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry });
    const toolMessage = provider.calls[1].messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMessage!.content as string)).toEqual({ text: payload });
    expect((toolMessage!.content as string).length).toBeLessThan(payload.length * 1.3);
  });

  it('prefers structuredContent as the result object', async () => {
    const result = await run({
      content: [{ type: 'text', text: '{"n":1}' }],
      structuredContent: { n: 1 },
    });
    expect(result).toEqual({ n: 1 });
  });

  it('preserves image, audio and resource parts in a JSON-serializable form', async () => {
    const result = await run({
      content: [
        { type: 'text', text: 'here' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        { type: 'audio', data: 'YXVk', mimeType: 'audio/wav' },
        { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hi' } },
        { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AAE=' } },
        { type: 'resource_link', uri: 'file:///c', name: 'c', description: 'link' },
        { type: 'hologram', depth: 3 },
      ],
    });
    // Eve TOOLS-F8: the JSON (what the model gets) carries a placeholder for base64 data; the parts keep it.
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      text: 'here',
      content: [
        { type: 'text', text: 'here' },
        { type: 'image', data: '[image: image/png, 4 base64 characters, not sent to the model]', mimeType: 'image/png' },
        { type: 'audio', data: '[audio: audio/wav, 4 base64 characters, not sent to the model]', mimeType: 'audio/wav' },
        { type: 'resource', uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hi' },
        { type: 'resource', uri: 'file:///b.bin', blob: '[resource: 4 base64 characters, not sent to the model]' },
        { type: 'resource_link', uri: 'file:///c', name: 'c', description: 'link' },
        { type: 'unknown', raw: { type: 'hologram', depth: 3 } },
      ],
    });
  });

  it('Eve TOOLS-F8: a 400 KB image reaches the JSON as a short placeholder; code still reads the data', async () => {
    const data = 'A'.repeat(400_000);
    const result = (await run({ content: [{ type: 'image', data, mimeType: 'image/png' }] })) as { content: Array<{ data: string }> };
    expect(result.content[0].data).toBe(data);
    const json = JSON.stringify(result);
    expect(json.length).toBeLessThan(200);
    expect(json).toContain('[image: image/png, 400000 base64 characters, not sent to the model]');
  });

  it('Eve TOOLS-F8: a tool description over 2,000 characters is cut', async () => {
    const description = 'd'.repeat(680_000);
    const client = { listTools: async () => ({ tools: [{ name: 'huge', description, inputSchema: { type: 'object' } }] }) } as unknown as Client;
    const tools = await loadMcpTools(client, 's');
    expect((tools.s__huge.tool as { description: string }).description.length).toBeLessThan(2_100);
    expect((tools.s__huge.tool as { description: string }).description).toContain('[description truncated from 680000 characters]');
  });

  it('keeps media next to structuredContent instead of dropping it', async () => {
    const result = await run({
      content: [
        { type: 'text', text: 'chart' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      ],
      structuredContent: { points: 3 },
    });
    expect(result).toEqual({
      structuredContent: { points: 3 },
      text: 'chart',
      content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
    });
  });

  it('throws McpToolError with the server text when isError is true', async () => {
    const error = await run({
      isError: true,
      content: [{ type: 'text', text: 'file not found' }],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpToolError);
    expect((error as Error).name).toBe('McpToolError');
    expect((error as Error).message).toBe('file not found');
  });

  it('gives an isError result without text a descriptive message', async () => {
    await expect(run({ isError: true, content: [] })).rejects.toThrow(/do_it.*error/);
  });

  it('returns a legacy result without a content array unchanged', async () => {
    expect(await run({ toolResult: 42 })).toEqual({ toolResult: 42 });
  });

  it('reaches the model as a structured { error, toolName, message } tool error', async () => {
    const client = fakeClient({ isError: true, content: [{ type: 'text', text: 'rate limited' }] });
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerMany(await loadMcpTools(client, 'srv', { approval: 'never' }));
    const agent = AgentBuilder.create()
      .setName('Test Agent')
      .addTool('srv__do_it', { tool: 'srv__do_it', options: {} })
      .build();
    const provider = mockModel([{ toolCalls: [{ name: 'srv__do_it' }] }, 'done']);
    const onToolResult = vi.fn();

    await AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry, onToolResult });

    const toolMessage = provider.calls[1].messages.find((m) => m.role === 'tool');
    expect(toolMessage?.isError).toBe(true);
    expect(JSON.parse(toolMessage!.content as string)).toEqual({
      error: 'McpToolError',
      toolName: 'srv__do_it',
      message: 'rate limited',
      kind: 'mcp',
    });
    expect(onToolResult.mock.calls[0][1]?.error).toBeDefined();
  });
});
