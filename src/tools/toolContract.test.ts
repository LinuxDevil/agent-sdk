import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import * as ai from 'ai';
import { defineTool } from './defineTool';
import { getToolExecute, getToolInputSchema, toolDescriptorFromSchema } from './toolContract';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { Message } from '../providers';
import type { ToolDescriptor } from '../types';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, tool: vi.fn(actual.tool) };
});

const input = z.object({ city: z.string(), unit: z.enum(['C', 'F']).default('C') });

function toolResults(messages: Message[]): unknown[] {
  return messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(String(m.content)));
}

describe('tool contract (LOU-D22)', () => {
  it('defineTool sets inputSchema and execute and runs end-to-end without ai.tool()', async () => {
    vi.mocked(ai.tool).mockClear();
    const execute = vi.fn(async ({ city, unit }: z.output<typeof input>) => ({ city, temp: `21${unit}` }));
    const weather = defineTool({ name: 'weather', description: 'Weather', input, execute });

    expect(weather.inputSchema).toBe(input);
    expect(weather.tool).toMatchObject({ description: 'Weather', parameters: input });
    expect(weather.tool.execute).toBe(weather.execute);

    const model = mockModel([
      { toolCalls: [{ name: 'weather', args: { city: 7 } }] },
      { toolCalls: [{ name: 'weather', args: { city: 'Paris' } }] },
      'Sunny.',
    ]);
    const agent = createAgent({ prompt: 'p', provider: model, tools: [weather] });
    const result = await agent.send('go');

    expect(result.text).toBe('Sunny.');
    expect(model.calls[0]?.tools?.[0]?.function).toMatchObject({ name: 'weather', parameters: input });
    const [invalid, ok] = toolResults(result.messages);
    expect(invalid).toMatchObject({ error: 'ToolArgumentsValidationError' });
    expect(ok).toEqual({ city: 'Paris', temp: '21C' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(ai.tool).not.toHaveBeenCalled();
  });

  it('still validates and runs a legacy descriptor built with ai.tool()', async () => {
    const execute = vi.fn(async ({ city }: { city: string }) => `legacy:${city}`);
    const legacy: ToolDescriptor = {
      displayName: 'Legacy',
      tool: ai.tool({ description: 'Legacy weather', parameters: z.object({ city: z.string() }), execute }),
    };
    const model = mockModel([
      { toolCalls: [{ name: 'legacy', args: {} }] },
      { toolCalls: [{ name: 'legacy', args: { city: 'Rome' } }] },
      'done',
    ]);
    const agent = createAgent({ prompt: 'p', provider: model, tools: { legacy } });
    const result = await agent.send('go');

    const [invalid, ok] = toolResults(result.messages);
    expect(invalid).toMatchObject({ error: 'ToolArgumentsValidationError' });
    expect(ok).toBe('legacy:Rome');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls[0]?.tools?.[0]?.function.description).toBe('Legacy weather');
  });

  it('prefers the canonical fields over the legacy tool and falls back to it', async () => {
    const canonical = z.object({ a: z.string() });
    const desc: ToolDescriptor = {
      displayName: 'd',
      inputSchema: canonical,
      execute: async () => 'canonical',
      tool: { parameters: z.object({}), execute: async () => 'legacy' },
    };
    expect(getToolInputSchema(desc)).toBe(canonical);
    expect(await getToolExecute(desc)?.({}, {} as never)).toBe('canonical');

    const legacyOnly: ToolDescriptor = { displayName: 'd', tool: desc.tool };
    expect(getToolInputSchema(legacyOnly)).toBe(desc.tool.parameters);
    expect(await getToolExecute(legacyOnly)?.({}, {} as never)).toBe('legacy');
    expect(getToolExecute({ displayName: 'd', tool: { parameters: canonical } })).toBeUndefined();
  });

  it('toolDescriptorFromSchema sets canonical and legacy fields without validating the name or description', async () => {
    const schema = z.object({ q: z.string() });
    const desc = toolDescriptorFromSchema({
      displayName: 'srv.search',
      description: '',
      inputSchema: schema,
      execute: async (args) => ({ echoed: args }),
    });
    expect(desc.inputSchema).toBe(schema);
    expect(desc.tool).toMatchObject({ description: '', parameters: schema });
    expect(desc.tool.execute).toBe(desc.execute);
    expect(await getToolExecute(desc)?.({ q: 'x' }, {} as never)).toEqual({ echoed: { q: 'x' } });
  });
});
