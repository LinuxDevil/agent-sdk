/**
 * LOU-V4: `createAgent({ output })` / `ExecuteOptions.output` - the final
 * reply is parsed and validated into `result.object`, with one repair step.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
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

  it('LOU-R7: closes every object node of a zod 4 output schema (strict endpoints reject open ones)', async () => {
    // zod 4's toJSONSchema emits no additionalProperties; OpenAI-compatible
    // strict structured outputs 400 on that. The sent schema must close each
    // object node - nested, in items, and inside combinators.
    const output = z4.object({
      city: z4.string(),
      geo: z4.object({ lat: z4.number() }),
      hits: z4.array(z4.object({ id: z4.string() })),
      choice: z4.union([z4.object({ a: z4.string() }), z4.object({ b: z4.number() })]),
    });
    const model = mockModel(['{"city":"Paris","geo":{"lat":1},"hits":[],"choice":{"a":"x"}}']);
    const agent = createAgent({ provider: model, output });

    await agent.send('go');

    const schema = model.calls[0].responseFormat?.schema as {
      additionalProperties: boolean;
      properties: {
        geo: { additionalProperties: boolean };
        hits: { items: { additionalProperties: boolean } };
        choice: { anyOf: Array<{ additionalProperties: boolean }> };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.geo.additionalProperties).toBe(false);
    expect(schema.properties.hits.items.additionalProperties).toBe(false);
    expect(schema.properties.choice.anyOf.map((b) => b.additionalProperties)).toEqual([false, false]);
  });

  it('LOU-R7.2: optional fields become required `| null` unions, and a strict null validates as absent', async () => {
    // Strict structured outputs reject a schema whose `required` does not
    // list every `properties` key (OpenRouter/OpenAI 400: "'required' is
    // required to be supplied and to be an array including every key in
    // properties"). The sent schema must therefore mark every key required
    // and turn each formerly-optional field into a `... | null` union; a
    // field already accepting null is required but not wrapped twice.
    const output = z4.object({
      city: z4.string(),
      nick: z4.string().optional(),
      when: z4.string().nullable().optional(),
      geo: z4.object({ lat: z4.number(), note: z4.string().optional() }),
    });
    const model = mockModel(['{"city":"Paris","nick":null,"when":null,"geo":{"lat":1,"note":null}}']);
    const agent = createAgent({ provider: model, output });

    const result = await agent.send('go');

    const schema = model.calls[0].responseFormat?.schema as {
      required: string[];
      properties: {
        nick: unknown;
        when: unknown;
        geo: { required: string[]; properties: { note: unknown } };
      };
    };
    expect(schema.required).toEqual(expect.arrayContaining(['city', 'nick', 'when', 'geo']));
    expect(schema.properties.nick).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(schema.properties.when).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(schema.properties.geo.required).toEqual(expect.arrayContaining(['lat', 'note']));
    expect(schema.properties.geo.properties.note).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    // The strict endpoint could not omit the keys, so the model wrote nulls.
    // The optional `nick`/`note` nulls validate back as "absent"; `when`'s
    // null is a real value (the field is genuinely nullable), so it stays.
    expect(result.object).toEqual({ city: 'Paris', when: null, geo: { lat: 1 } });
    expect(result.finishReason).toBe('stop');
  });

  it('LOU-R7.2: a null the model sent for a genuinely nullable field is kept', async () => {
    const output = z4.object({ city: z4.string(), when: z4.string().nullable() });
    const agent = createAgent({ provider: mockModel(['{"city":"Paris","when":null}']), output });

    expect((await agent.send('go')).object).toEqual({ city: 'Paris', when: null });
  });

  it('LOU-R7.2: the zod 3 path expands required the same way', async () => {
    const output = z.object({ city: z.string(), nick: z.string().optional() });
    const model = mockModel(['{"city":"Paris","nick":null}']);
    const agent = createAgent({ provider: model, output });

    const result = await agent.send('go');

    const schema = model.calls[0].responseFormat?.schema as { required: string[]; properties: { nick: unknown } };
    expect(schema.required).toEqual(expect.arrayContaining(['city', 'nick']));
    expect(schema.properties.nick).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(result.object).toEqual({ city: 'Paris' });
  });

  it('LOU-R7: an explicit additionalProperties is kept, never forced closed', async () => {
    const strict = mockModel(['{"city":"Paris"}']);
    await createAgent({ provider: strict, output: z4.strictObject({ city: z4.string() }) }).send('go');
    expect((strict.calls[0].responseFormat?.schema as { additionalProperties?: unknown }).additionalProperties).toBe(false);

    // A zod 4 loose object means "extra keys allowed" ({} = any); closing it would change the contract.
    const loose = mockModel(['{"city":"Paris","extra":1}']);
    await createAgent({ provider: loose, output: z4.looseObject({ city: z4.string() }) }).send('go');
    expect((loose.calls[0].responseFormat?.schema as { additionalProperties?: unknown }).additionalProperties).toEqual({});
  });

  it('LOU-R7: the zod 3 path still sends a closed schema', async () => {
    const model = mockModel(['{"city":"Paris","tempC":21}']);
    await createAgent({ provider: model, output: weather }).send('go');

    const schema = model.calls[0].responseFormat?.schema as { additionalProperties?: unknown };
    expect(schema.additionalProperties).toBe(false);
  });
});
