/**
 * Live test (costs money, needs OPENROUTER_API_KEY; at most 0.05 USD): the real `ai` 6 package through OpenRouter (M8).
 * One `createAgent({ model: 'openrouter/openai/gpt-4o-mini', maxSteps: 3 })` turn with one tool call through `send()`
 * and one through `stream()`. Run with `npm install --no-save ai@6 @ai-sdk/openai@3`, then
 * `npm run test:live -- src/providers/aiV6OpenRouter`, then `npm ci`. No cassette: a cassette replays at the provider
 * boundary and would not exercise `ai` 6.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import '../providers'; // registers the real providers (openrouter)
import { defineTool } from '../tools/defineTool';

function setup() {
  const runs: Array<{ a: number; b: number }> = [];
  const add = defineTool({
    name: 'add',
    description: 'Adds two numbers',
    input: z.object({ a: z.number(), b: z.number() }),
    execute: (input) => (runs.push(input), String(input.a + input.b)),
  });
  const agent = createAgent({ model: 'openrouter/openai/gpt-4o-mini', maxSteps: 3, tools: [add] });
  return { agent, runs };
}

describe.skipIf(!process.env.OPENROUTER_API_KEY)('ai 6 through OpenRouter (live, M8)', () => {
  it('send() runs the tool and answers', async () => {
    const { agent, runs } = setup();
    const result = await agent.send('Use the add tool to add 2 and 3, then reply with the number only.');
    expect(runs).toEqual([{ a: 2, b: 3 }]);
    expect(result.text).toContain('5');
  });

  it('stream() runs the tool and streams the reply in more than one text.delta', async () => {
    const { agent, runs } = setup();
    const deltas: string[] = [];
    for await (const event of agent.stream('Call the add tool once with 4 and 5. Then reply with two sentences about the number you got.')) {
      if (event.type === 'text.delta') deltas.push(event.text);
    }
    expect(runs).toEqual([{ a: 4, b: 5 }]);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toContain('9');
  });
});
