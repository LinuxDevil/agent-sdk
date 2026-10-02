/**
 * Live test (costs money, needs OPENROUTER_API_KEY): an `@ai-sdk/openai`
 * model pointed at OpenRouter, wrapped with `fromAiSdk()`, runs a tool loop.
 * Run with `npx vitest run --config vitest.live.config.ts src/providers/fromAiSdk.live.test.ts`
 * (or `npm run test:live`). Records `__fixtures__/cassettes/from-ai-sdk-openrouter.json`.
 */

import { describe, expect, it } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { recordReplay } from '../testing';
import { fromAiSdk } from './fromAiSdk';

describe.skipIf(!process.env.OPENROUTER_API_KEY)('fromAiSdk() through OpenRouter (live)', () => {
  it('runs the add tool once and answers 5', async () => {
    const openrouter = createOpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' });
    const provider = recordReplay(fromAiSdk(openrouter.chat('openai/gpt-4o-mini')), {
      cassette: 'src/providers/__fixtures__/cassettes/from-ai-sdk-openrouter.json',
      mode: 'record',
    });
    const runs: Array<{ a: number; b: number }> = [];
    const add = defineTool({
      name: 'add',
      description: 'Adds two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      execute: (input) => (runs.push(input), String(input.a + input.b)),
    });

    const result = await createAgent({ provider, maxSteps: 3, tools: [add] }).send(
      'Use the add tool to add 2 and 3, then reply with the number only.'
    );

    expect(runs).toEqual([{ a: 2, b: 3 }]);
    expect(result.text).toContain('5');
  });
});
