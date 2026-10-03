/**
 * Live test for code mode (N14): an agent with `codeMode: { exclusive: true }`
 * and two cheap local tools answers a question that needs four tool calls with
 * one `run_code` call (openrouter/openai/gpt-4o-mini, `maxSteps: 4`).
 *
 * - Replay (default): the model is served from
 *   `__fixtures__/cassettes/n14-code-mode.json`, so the test costs nothing.
 * - Record: `LOUSHO_RECORD=1` with `OPENROUTER_API_KEY` set (at most 0.10 USD).
 *   Grep the cassette for `sk-or-` and `Authorization` before committing it.
 *
 * Skipped when the cassette is missing and no key is set.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import '../providers'; // registers the real providers (openrouter)
import { resolveProvider } from '../providers/resolveProvider';
import { recordReplay } from '../testing';
import { defineTool } from '../tools/defineTool';
import type { AgentEvent, AgentEventOf } from './agentEvents';

const cassette = path.join(__dirname, '__fixtures__', 'cassettes', 'n14-code-mode.json');
const recording = Boolean(process.env.LOUSHO_RECORD);
const runnable = recording ? Boolean(process.env.OPENROUTER_API_KEY) : fs.existsSync(cassette);

const PRICES: Record<string, number> = { apple: 1.2, pear: 0.8, plum: 2 };
const RATES: Record<string, number> = { EUR: 0.9, GBP: 0.8 };

describe.skipIf(!runnable)('code mode live (N14)', () => {
  // Recorded 2026-10-03: gpt-4o-mini's first script guessed the shape of get_price's result and failed; the
  // error listed the calls' results, and its second script was right. So the test asks for a successful
  // run_code call (not exactly one), as the ticket allows when the model needs a retry.
  it('a run_code call makes the tool calls and the answer has the right total', async () => {
    const getPrice = defineTool({
      name: 'get_price',
      description: 'The price of one fruit in USD',
      input: z.object({ item: z.string().describe('apple, pear or plum') }),
      execute: async ({ item }) => ({ item, usd: PRICES[item.toLowerCase()] ?? null }),
    });
    const convert = defineTool({
      name: 'convert',
      description: 'Converts an amount in USD to another currency',
      input: z.object({ amount: z.number(), to: z.enum(['EUR', 'GBP']) }),
      execute: async ({ amount, to }) => ({ amount: Math.round(amount * RATES[to] * 100) / 100, currency: to }),
    });
    const agent = createAgent({
      provider: recordReplay(() => resolveProvider('openrouter/openai/gpt-4o-mini'), { cassette, mode: recording ? 'record' : 'replay' }),
      instructions: 'Answer in one sentence.',
      tools: [getPrice, convert],
      codeMode: { exclusive: true },
      maxSteps: 4,
    });

    const events: AgentEvent[] = [];
    const run = agent.stream('What do an apple, a pear and a plum cost together in EUR? Use run_code once.');
    for await (const event of run) events.push(event);
    const result = await run.result;

    const starts = events.filter((e): e is AgentEventOf<'tool.start'> => e.type === 'tool.start');
    const runCode = starts.filter((e) => e.toolName === 'run_code');
    expect(runCode.length).toBeGreaterThanOrEqual(1);
    expect(runCode.length).toBeLessThanOrEqual(2);
    // The last script succeeded, with at least three inner calls.
    const last = runCode.at(-1)?.toolCallId;
    expect(events.find((e): e is AgentEventOf<'tool.done'> => e.type === 'tool.done' && e.toolCallId === last)?.result).toMatchObject({ result: expect.anything() });
    expect(starts.filter((e) => e.parentToolCallId === last).length).toBeGreaterThanOrEqual(3);
    // exclusive: the model called no tool directly.
    expect(starts.filter((e) => e.toolName !== 'run_code' && e.parentToolCallId === undefined)).toEqual([]);
    expect(result.finishReason).toBe('stop');
    // 1.20 + 0.80 + 2.00 = 4.00 USD = 3.60 EUR
    expect(result.text).toMatch(/3[.,]6/);
  });
});
