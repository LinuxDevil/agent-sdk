/**
 * CI replay of the M2 live recording (`__fixtures__/cassettes/from-ai-sdk-openrouter.json`): an `@ai-sdk/openai` model
 * pointed at OpenRouter, wrapped with `fromAiSdk()`, ran a tool loop. No key, no network. Re-record with
 * `npx vitest run --config vitest.live.config.ts src/providers/fromAiSdk.live.test.ts`.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { recordReplay } from '../testing';
import { defineTool } from '../tools/defineTool';

const CASSETTE = join(__dirname, '__fixtures__', 'cassettes', 'from-ai-sdk-openrouter.json');

describe('fromAiSdk() through OpenRouter, replayed from a real recording (M2)', () => {
  it('runs the add tool once and answers 5', async () => {
    const provider = recordReplay(undefined, { cassette: CASSETTE, mode: 'replay' });
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
