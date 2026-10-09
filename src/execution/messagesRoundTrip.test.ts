/**
 * Eve CORE-F4: `result.messages` fed back into `send()` (the documented
 * `Message[]` input) must not send the system prompt twice.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';

const lookup = defineTool({ name: 'lookup', description: 'l', input: z.object({ q: z.string() }), execute: async ({ q }) => `data for ${q}` });

describe('result.messages round trip (Eve CORE-F4)', () => {
  it('sends one system message when the input already starts with the agent prompt', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'lookup', args: { q: 'a' } }] }, 'first answer', 'second answer']);
    const agent = createAgent({ provider: model, instructions: 'You are TERSE.', tools: [lookup] });

    const first = await agent.send('question one');
    const second = await agent.send([...first.messages, { role: 'user', content: 'question two' }]);

    const systems = model.lastCall!.messages.filter((m) => m.role === 'system');
    expect(systems).toHaveLength(1);
    expect(second.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user', 'assistant']);
  });

  it('still prepends the agent prompt when the input starts with a different system message', async () => {
    const model = mockModel(['ok']);
    const agent = createAgent({ provider: model, instructions: 'You are TERSE.' });

    const result = await agent.send([
      { role: 'system', content: 'Extra context.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(result.messages.slice(0, 2)).toEqual([
      { role: 'system', content: 'You are TERSE.' },
      { role: 'system', content: 'Extra context.' },
    ]);
  });
});
