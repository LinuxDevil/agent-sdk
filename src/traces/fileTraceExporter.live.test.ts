/**
 * Live test (costs money, needs OPENROUTER_API_KEY; at most 0.05 USD): one
 * real turn with one tool call through `openrouter/openai/gpt-4o-mini`,
 * traced by fileTraceExporter(). Checks that the saved trace has real token
 * counts and a cost, and that `lousho traces <id>` prints the tree. Run with
 * `npm run test:live -- src/traces`. With `LOUSHO_RECORD_TRACE_FIXTURE=1` it
 * also copies the trace to `__fixtures__/live-trace.jsonl` (content capture
 * off; grep it for `sk-or-` and `Authorization` before committing).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runTraces } from '../cli/traces';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { fileTraceExporter } from './fileTraceExporter';
import { listTraces } from './readTraces';

describe.skipIf(!process.env.OPENROUTER_API_KEY)('fileTraceExporter live (M5a)', () => {
  it('saves a real run with tokens and cost, and lousho traces prints it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-live-traces-'));
    const getWeather = defineTool({
      name: 'get_weather',
      description: 'Current weather for a city',
      input: z.object({ city: z.string() }),
      execute: async ({ city }) => `Sunny, 21 C in ${city}`,
    });
    const agent = createAgent({
      name: 'weather',
      model: 'openrouter/openai/gpt-4o-mini',
      instructions: 'Answer in one short sentence. Use get_weather for weather questions.',
      tools: [getWeather],
      maxSteps: 3,
      captureContent: false,
      exporter: fileTraceExporter({ dir }),
    });

    await agent.send('What is the weather in Paris?');

    const [trace] = await listTraces({ dir });
    expect(trace.modelCalls).toBeGreaterThan(0);
    expect(trace.toolCalls).toBe(1);
    expect(trace.inputTokens).toBeGreaterThan(0);
    expect(trace.outputTokens).toBeGreaterThan(0);
    expect(trace.costUsd).toBeGreaterThan(0);

    const out: string[] = [];
    expect(await runTraces([trace.traceId, '--dir', dir], { log: (text) => out.push(text), color: false })).toBe(0);
    expect(out.join('\n')).toContain('execute_tool get_weather');

    if (process.env.LOUSHO_RECORD_TRACE_FIXTURE === '1') {
      fs.copyFileSync(trace.file, path.join(__dirname, '__fixtures__', 'live-trace.jsonl'));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
