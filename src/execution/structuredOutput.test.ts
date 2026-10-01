/**
 * LOU-V4: `createAgent({ output })` / `ExecuteOptions.output` - the final
 * reply is parsed and validated into `result.object`, with one repair step.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { AgentEvent } from './agentEvents';

const weather = z.object({ city: z.string(), tempC: z.number() });

describe('structured output (LOU-V4)', () => {
  it('validates a JSON reply into result.object and keeps the raw text', async () => {
    const model = mockModel(['{"city":"Paris","tempC":21}']);
    const agent = createAgent({ provider: model, instructions: 'You report weather.', output: weather });

    const result = await agent.send('Weather in Paris?');

    expect(result.object).toEqual({ city: 'Paris', tempC: 21 });
    expect(result.text).toBe('{"city":"Paris","tempC":21}');
    expect(result.finishReason).toBe('stop');
    expect(result.outputError).toBeUndefined();
    const request = model.calls[0];
    expect(request.responseFormat).toMatchObject({ type: 'json', schema: { type: 'object', required: ['city', 'tempC'] } });
    const system = request.messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toMatch(/^You report weather\.\n\n## Output format\n/);
    expect(system.content).toContain('"tempC":{"type":"number"}');
  });

  it('applies the schema (defaults, transforms) to the parsed object', async () => {
    const schema = z.object({ tags: z.array(z.string()).default([]), name: z.string().transform((s) => s.toUpperCase()) });
    const agent = createAgent({ provider: mockModel(['{"name":"ada"}']), output: schema });

    expect((await agent.send('go')).object).toEqual({ tags: [], name: 'ADA' });
  });

  it('accepts a reply wrapped in a code fence', async () => {
    const agent = createAgent({ provider: mockModel(['```json\n{"city":"Oslo","tempC":-3}\n```']), output: weather });

    const result = await agent.send('Weather in Oslo?');

    expect(result.object).toEqual({ city: 'Oslo', tempC: -3 });
    expect(result.steps).toBe(1);
  });

  it('repairs an invalid reply with one more step that lists the issues', async () => {
    const model = mockModel(['{"city":"Paris","tempC":"warm"}', '{"city":"Paris","tempC":21}']);
    const agent = createAgent({ provider: model, output: weather });

    const result = await agent.send('Weather in Paris?');

    expect(result.object).toEqual({ city: 'Paris', tempC: 21 });
    expect(result.finishReason).toBe('stop');
    expect(result.steps).toBe(2);
    const repair = model.calls[1].messages.at(-1);
    expect(repair?.role).toBe('user');
    expect(repair?.content).toBe(
      '[output-invalid] The reply does not match the output schema: 1 issue (tempC: Expected number, received string). ' +
        'Reply again with only the corrected JSON object.'
    );
    expect(model.calls[1].messages.at(-2)).toEqual({ role: 'assistant', content: '{"city":"Paris","tempC":"warm"}' });
  });

  it("ends with 'output-invalid' and outputError when the repair is invalid too", async () => {
    const model = mockModel(['It is sunny.', '{"city":"Paris"}']);
    const agent = createAgent({ provider: model, output: weather });

    const result = await agent.send('Weather in Paris?');

    expect(model.calls).toHaveLength(2);
    expect(model.calls[1].messages.at(-1)?.content).toMatch(/^\[output-invalid\] The reply is not a JSON object: 1 issue \(\(root\): Not valid JSON: /);
    expect(result.finishReason).toBe('output-invalid');
    expect(result.object).toBeUndefined();
    expect(result.text).toBe('{"city":"Paris"}');
    expect(result.outputError).toEqual({
      message: 'The reply does not match the output schema: 1 issue (tempC: Required)',
      issues: [{ path: 'tempC', message: 'Required' }],
    });
  });

  it('counts the repair against maxSteps: no budget left means no repair', async () => {
    const model = mockModel(['nope']);
    const agent = createAgent({ provider: model, output: weather, maxSteps: 1 });

    const result = await agent.send('go');

    expect(model.calls).toHaveLength(1);
    expect(result.finishReason).toBe('output-invalid');
    expect(result.outputError?.issues[0].path).toBe('(root)');
  });

  it('runs tool calls before the final JSON answer', async () => {
    const lookup = defineTool({
      name: 'lookup',
      description: 'Current temperature',
      input: z.object({ city: z.string() }),
      execute: async () => 21,
    });
    const model = mockModel([{ toolCalls: [{ name: 'lookup', args: { city: 'Paris' } }] }, '{"city":"Paris","tempC":21}']);
    const agent = createAgent({ provider: model, tools: [lookup], output: weather });

    const result = await agent.send('Weather in Paris?');

    expect(result.object).toEqual({ city: 'Paris', tempC: 21 });
    expect(result.toolCalls).toHaveLength(1);
    expect(model.calls[0].tools).toHaveLength(1);
    expect(model.calls[0].responseFormat?.type).toBe('json');
  });

  it('stream(): run.result and run.done carry the object', async () => {
    const agent = createAgent({ provider: mockModel(['{"city":"Rome"', '{"city":"Rome","tempC":30}']), output: weather });

    const run = agent.stream('Weather in Rome?');
    const events: AgentEvent[] = [];
    for await (const event of run) events.push(event);

    const result = await run.result;
    expect(result.object).toEqual({ city: 'Rome', tempC: 30 });
    expect(events.filter((e) => e.type === 'step.start')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop', object: { city: 'Rome', tempC: 30 } });
  });

  it('stream(): run.done has no object when the output is invalid', async () => {
    const agent = createAgent({ provider: mockModel(['x', 'y']), output: weather });

    const run = agent.stream('go');
    const events: AgentEvent[] = [];
    for await (const event of run) events.push(event);

    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'run.done', finishReason: 'output-invalid' });
    expect(done).not.toHaveProperty('object');
    expect((await run.result).outputError?.issues).toHaveLength(1);
  });

  it('leaves agents without output unchanged', async () => {
    const model = mockModel(['not json']);
    const result = await createAgent({ provider: model, instructions: 'Hi.' }).send('go');

    expect(result).not.toHaveProperty('object');
    expect(model.calls[0]).not.toHaveProperty('responseFormat');
    expect(model.calls[0].messages[0].content).toBe('Hi.');
  });
});
