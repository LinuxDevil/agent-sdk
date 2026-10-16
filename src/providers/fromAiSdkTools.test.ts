/**
 * `fromAiSdkTools(record)` - AI SDK tools (v4 `parameters`, v7
 * `inputSchema`; zod or `jsonSchema()`) as Lousho tools, run by createAgent.
 */

import { describe, expect, it, vi } from 'vitest';
import { jsonSchema as jsonSchemaV4, tool as toolV4 } from 'ai';
import { jsonSchema as jsonSchemaV7, tool as toolV7 } from 'ai-v7';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { isDefinedTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { Message } from './llm';
import { fromAiSdkTools } from './fromAiSdkTools';
import * as root from '../index';

const weatherCall = { toolCalls: [{ name: 'weather', args: { city: 'Paris' }, id: 'call_weather' }] };

function toolResult(messages: readonly Message[]): Message | undefined {
  return messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_weather');
}

/** True when the (zod) schema accepts `{ city }` and rejects `{}` and a numeric city. */
function acceptsCityOnly(schema: unknown): boolean {
  const parse = (value: unknown) => (schema as z.ZodTypeAny).safeParse(value).success;
  return parse({ city: 'Paris' }) && !parse({}) && !parse({ city: 1 });
}

describe('fromAiSdkTools', () => {
  it('is exported from the package root', () => {
    expect(root.fromAiSdkTools).toBe(fromAiSdkTools);
  });

  it('converts an ai v7 tool with a zod inputSchema and runs it in createAgent with the call id and abort signal', async () => {
    const execute = vi.fn(async ({ city }: { city: string }, _options: { toolCallId: string; abortSignal?: AbortSignal }) => `Sunny in ${city}`);
    const weather = toolV7({ description: 'Get the weather', inputSchema: z.object({ city: z.string() }), execute });
    const tools = fromAiSdkTools({ weather });

    expect(tools).toHaveLength(1);
    expect(isDefinedTool(tools[0])).toBe(true);
    expect(tools[0]).toMatchObject({ name: 'weather', description: 'Get the weather' });

    const model = mockModel([weatherCall, 'It is sunny.']);
    const agent = createAgent({ provider: model, tools });
    const controller = new AbortController();
    const result = await agent.send('Weather in Paris?', { signal: controller.signal });

    expect(result.text).toBe('It is sunny.');
    expect(toolResult(result.messages)?.content).toBe(JSON.stringify('Sunny in Paris'));
    expect(execute).toHaveBeenCalledTimes(1);
    const [args, options] = execute.mock.calls[0];
    expect(args).toEqual({ city: 'Paris' });
    expect(options.toolCallId).toBe('call_weather');
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    // The model is sent the tool's schema.
    expect(acceptsCityOnly(model.calls[0].tools?.find((t) => t.function.name === 'weather')?.function.parameters)).toBe(true);
  });

  it('converts an ai v4-shaped tool with zod `parameters`', async () => {
    const weather = toolV4({ description: 'Get the weather', parameters: z.object({ city: z.string() }), execute: async ({ city }) => `Rain in ${city}` });
    const agent = createAgent({ provider: mockModel([weatherCall, 'Rainy.']), tools: fromAiSdkTools({ weather }) });
    const result = await agent.send('Weather?');
    expect(toolResult(result.messages)?.content).toBe(JSON.stringify('Rain in Paris'));
  });

  for (const [label, jsonSchema] of [
    ['v7', jsonSchemaV7],
    ['(installed, v4 by default)', jsonSchemaV4],
  ] as const) {
    it(`converts an ai ${label} jsonSchema() schema and validates arguments against it`, async () => {
      const execute = vi.fn(async (input: { city: string }) => `Fog in ${input.city}`);
      const schema = jsonSchema<{ city: string }>({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] });
      const [weather] = fromAiSdkTools({ weather: { description: 'Get the weather', inputSchema: schema, execute } });

      const model = mockModel([{ toolCalls: [{ name: 'weather', args: {}, id: 'call_weather' }] }, weatherCall, 'Foggy.']);
      const agent = createAgent({ provider: model, tools: [weather] });
      const result = await agent.send('Weather?');

      // The first call misses `city`: rejected before execute, the model retries.
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0]).toEqual({ city: 'Paris' });
      expect(result.text).toBe('Foggy.');
      expect(acceptsCityOnly(model.calls[0].tools?.[0].function.parameters)).toBe(true);
    });
  }

  it("runs a jsonSchema() wrapper's own validate and passes its parsed value", async () => {
    const execute = vi.fn(async (input: { city: string }) => input.city);
    const schema = jsonSchemaV7<{ city: string }>(
      { type: 'object', properties: { city: { type: 'string' } } },
      { validate: async (value) => ({ success: true, value: { city: String((value as { city: string }).city).toUpperCase() } }) }
    );
    const tools = fromAiSdkTools({ weather: { description: 'w', inputSchema: schema, execute } });
    const agent = createAgent({ provider: mockModel([weatherCall, 'ok']), tools });
    await agent.send('Weather?');
    expect(execute.mock.calls[0][0]).toEqual({ city: 'PARIS' });
  });

  it('maps needsApproval: true to a Lousho approval pause', async () => {
    const execute = vi.fn(async ({ city }: { city: string }) => `Sunny in ${city}`);
    const weather = toolV7({ description: 'Get the weather', inputSchema: z.object({ city: z.string() }), needsApproval: true, execute });
    const agent = createAgent({ provider: mockModel([weatherCall, 'Done.']), tools: fromAiSdkTools({ weather }) });

    const paused = await agent.send('Weather?');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(execute).not.toHaveBeenCalled();

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Done.');
  });

  it('maps a needsApproval function, passing the input and the call id', async () => {
    const checks: Array<{ city: string; toolCallId: string }> = [];
    const weather = toolV7({
      description: 'w',
      inputSchema: z.object({ city: z.string() }),
      needsApproval: async ({ city }, { toolCallId }) => (checks.push({ city, toolCallId }), city === 'Paris'),
      execute: async () => 'ok',
    });
    const agent = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'weather', args: { city: 'Rome' }, id: 'call_rome' }] }, weatherCall, 'x']),
      tools: fromAiSdkTools({ weather }),
    });

    const paused = await agent.send('Weather?');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(checks).toEqual([
      { city: 'Rome', toolCallId: 'call_rome' },
      { city: 'Paris', toolCallId: 'call_weather' },
    ]);
  });

  it('turns an error thrown by execute into a tool error the model sees', async () => {
    const weather = toolV7({
      description: 'w',
      inputSchema: z.object({ city: z.string() }),
      execute: async (): Promise<string> => {
        throw new Error('weather service down');
      },
    });
    const agent = createAgent({ provider: mockModel([weatherCall, 'Sorry.']), tools: fromAiSdkTools({ weather }) });
    const result = await agent.send('Weather?');
    expect(result.text).toBe('Sorry.');
    expect(String(toolResult(result.messages)?.content)).toContain('weather service down');
  });

  it('streams an async iterable result; the last value is the result', async () => {
    const weather = toolV7({
      description: 'w',
      inputSchema: z.object({ city: z.string() }),
      async *execute({ city }) {
        yield { status: 'loading' };
        yield { status: 'done', city };
      },
    });
    const agent = createAgent({ provider: mockModel([weatherCall, 'ok']), tools: fromAiSdkTools({ weather }) });
    const result = await agent.send('Weather?');
    expect(toolResult(result.messages)?.content).toBe(JSON.stringify({ status: 'done', city: 'Paris' }));
  });

  it('accepts a tool with no schema as taking no arguments', () => {
    const [ping] = fromAiSdkTools({ ping: { description: 'Ping', execute: async () => 'pong' } });
    expect(ping.name).toBe('ping');
  });

  it('calls an ai v7 description function', () => {
    const [ping] = fromAiSdkTools({ ping: { description: () => 'Ping the server', execute: async () => 'pong' } });
    expect(ping.description).toBe('Ping the server');
  });

  it('rejects a tool without execute, a provider-defined tool and an invalid name', () => {
    expect(() => fromAiSdkTools({ ask: { description: 'Ask the user', inputSchema: z.object({}) } })).toThrow(/no execute/);
    expect(() => fromAiSdkTools({ web_search: { type: 'provider-defined', description: 'x' } })).toThrow(/hosted tools/);
    expect(() => fromAiSdkTools({ 'bad name': { description: 'x', execute: async () => 1 } })).toThrow(/invalid tool name/);
    expect(() => fromAiSdkTools([] as never)).toThrow(/record of AI SDK tools/);
  });
});
