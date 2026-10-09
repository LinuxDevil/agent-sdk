/**
 * Eve CORE-F13: an `output` agent's stream carries `object.delta` events with
 * the reply parsed so far.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { AgentEvent } from './agentEvents';

const reply = { title: 'Hello world', tags: ['a', 'b'] };

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const event of run) seen.push(event);
  return seen;
}

describe('object.delta (Eve CORE-F13)', () => {
  it('streams the partial object as the JSON reply arrives, each one different, ending at the validated object', async () => {
    const agent = createAgent({
      provider: mockModel([JSON.stringify(reply, null, 1)]),
      output: z.object({ title: z.string(), tags: z.array(z.string()) }),
    });
    const run = agent.stream('go');
    const seen = await collect(run);

    const objects = seen.flatMap((event) => (event.type === 'object.delta' ? [event.object] : []));
    expect(objects.length).toBeGreaterThan(2);
    expect(objects[0]).toEqual({});
    expect(objects).toContainEqual({ title: 'Hello ' });
    expect(objects.at(-1)).toEqual(reply);
    expect(new Set(objects.map((object) => JSON.stringify(object))).size).toBe(objects.length);

    // Each object.delta follows the text.delta that produced it.
    const firstObject = seen.findIndex((event) => event.type === 'object.delta');
    expect(seen[firstObject - 1].type).toBe('text.delta');
    expect((await run.result).object).toEqual(reply);
  });

  it('is not emitted for an agent without output', async () => {
    const seen = await collect(createAgent({ provider: mockModel(['{"looks": "like json"}']) }).stream('go'));
    expect(seen.some((event) => event.type === 'object.delta')).toBe(false);
  });

  it('reaches a send() onEvent listener too', async () => {
    const objects: unknown[] = [];
    await createAgent({ provider: mockModel(['{"n": 1}']), output: z.object({ n: z.number() }) }).send('go', {
      onEvent: (event) => {
        if (event.type === 'object.delta') objects.push(event.object);
      },
    });
    expect(objects.at(-1)).toEqual({ n: 1 });
  });
});
