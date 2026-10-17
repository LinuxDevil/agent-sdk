/**
 * Live test (costs money, needs OPENROUTER_API_KEY; well under 0.05 USD): the
 * documented headline setup - `openrouter/openai/gpt-4o-mini`, one tool and a
 * zod `output` schema. With a strict `json_schema` response format on every
 * call, this model called the tool on every step until `maxSteps`; the
 * response format now goes only on calls that offer no tools, and the run
 * answers in a few steps with a valid object.
 * Run with `npm run test:live -- src/execution/structuredOutputTools`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import '../providers'; // registers the real providers (openrouter)
import { defineTool } from '../tools/defineTool';

const weather = defineTool({
  name: 'get_weather',
  description: 'Current temperature in Celsius for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

describe.skipIf(!process.env.OPENROUTER_API_KEY)('output schema + tools on a real model', () => {
  it('answers with a valid object instead of calling tools until maxSteps', async () => {
    const agent = createAgent({
      model: 'openrouter/openai/gpt-4o-mini',
      tools: [weather],
      output: z.object({ city: z.string(), tempC: z.number() }),
      maxSteps: 6,
    });

    const result = await agent.send('What is the weather in Paris?');

    expect(result.finishReason).toBe('stop');
    expect(result.object).toEqual({ city: 'Paris', tempC: 21 });
    expect(result.steps).toBeLessThanOrEqual(3);
  }, 60_000);
});
