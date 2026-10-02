/**
 * M5a: fileTraceExporter() writes each run of a createAgent() agent as one
 * JSON Lines file under `<dir>/<YYYY-MM-DD>/<traceId>.jsonl`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { fileTraceExporter } from './fileTraceExporter';
import type { TraceLine } from './format';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-traces-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const weather = defineTool({
  name: 'get_weather',
  description: 'Weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => `Sunny in ${city}`,
});

const callWeather = {
  toolCalls: [{ name: 'get_weather', args: { city: 'Paris' }, id: 'call_1' }],
  usage: { inputTokens: 20, outputTokens: 5 },
};

/** Every trace file under `dir`, each as its parsed lines. */
function traceFiles(): { file: string; lines: TraceLine[] }[] {
  const days = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  return days.flatMap((day) =>
    fs.readdirSync(path.join(dir, day)).map((name) => {
      const file = path.join(dir, day, name);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as TraceLine);
      return { file, lines };
    })
  );
}

const ops = (lines: TraceLine[]) => lines.map((line) => line.attributes['gen_ai.operation.name']);

describe('fileTraceExporter (M5a)', () => {
  it('writes one run with a tool call as one file of invoke_agent, chat and execute_tool spans sharing a traceId', async () => {
    const agent = createAgent({
      name: 'weather',
      provider: mockModel([callWeather, { text: 'It is sunny.', usage: { inputTokens: 30, outputTokens: 4 } }]),
      tools: [weather],
      exporter: fileTraceExporter({ dir }),
    });

    await agent.send('Weather in Paris?');

    const files = traceFiles();
    expect(files).toHaveLength(1);
    const [{ file, lines }] = files;
    const root = lines.find((line) => line.parentId === undefined)!;
    expect(root.name).toBe('invoke_agent weather');
    expect(path.basename(file)).toBe(`${root.id}.jsonl`);
    expect(path.basename(path.dirname(file))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(lines.map((line) => line.traceId))).toEqual(new Set([root.id]));
    expect(ops(lines).sort()).toEqual(['chat', 'chat', 'execute_tool', 'invoke_agent']);
    for (const line of lines) {
      expect(line.v).toBe(1);
      expect(typeof line.startTime).toBe('number');
      expect(line.endTime).toBeGreaterThanOrEqual(line.startTime);
    }
    // Written as spans end: the root, which ends last, is the last line.
    expect(lines.at(-1)!.id).toBe(root.id);
    const tool = lines.find((line) => line.name === 'execute_tool get_weather')!;
    expect(tool.parentId).toBe(root.id);
    expect(tool.attributes['gen_ai.tool.name']).toBe('get_weather');
  });

  it('a session with two turns writes two traces', async () => {
    const agent = createAgent({ provider: mockModel(['Hi.', 'Bye.']), exporter: fileTraceExporter({ dir }) });
    const session = agent.session();

    await session.send('Hello');
    await session.send('Goodbye');

    const files = traceFiles();
    expect(files).toHaveLength(2);
    for (const { lines } of files) expect(ops(lines).sort()).toEqual(['chat', 'invoke_agent']);
  });

  it("puts a sub-agent's spans in the lead's trace", async () => {
    const researcher = createAgent({ name: 'researcher', description: 'Finds facts', provider: mockModel(['Paris is in France.']) });
    const task = { name: 'task', args: { agent: 'researcher', prompt: 'Where is Paris?', description: 'look up' } };
    const lead = createAgent({
      name: 'lead',
      provider: mockModel([{ toolCalls: [task] }, 'France.']),
      subagents: { researcher },
      exporter: fileTraceExporter({ dir }),
    });

    await lead.send('Where is Paris?');

    const files = traceFiles();
    expect(files).toHaveLength(1);
    const names = files[0].lines.map((line) => line.name);
    expect(names).toContain('invoke_agent lead');
    expect(names).toContain('invoke_agent researcher');
    expect(new Set(files[0].lines.map((line) => line.traceId)).size).toBe(1);
  });

  it('warns once when the directory cannot be written, and the run still succeeds', async () => {
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'a file where the trace folder should be');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const agent = createAgent({
      provider: mockModel([callWeather, 'Sunny.', 'Again.']),
      tools: [weather],
      exporter: fileTraceExporter({ dir: path.join(blocker, 'traces') }),
    });

    expect((await agent.send('Weather?')).text).toBe('Sunny.');
    expect((await agent.send('Again?')).text).toBe('Again.');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/fileTraceExporter could not write/);
  });

  it('defaults to .lousho/traces under the working directory', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const exporter = fileTraceExporter();
    const span = { id: 'root1', name: 'invoke_agent x', attributes: {}, startTime: Date.now() };
    exporter.onSpanStart(span);
    exporter.onSpanEnd({ ...span, endTime: span.startTime + 5 });

    const days = fs.readdirSync(path.join(dir, '.lousho', 'traces'));
    expect(fs.existsSync(path.join(dir, '.lousho', 'traces', days[0], 'root1.jsonl'))).toBe(true);
  });

  it('writes attributes that JSON cannot hold as-is (bigints, cycles) without throwing', () => {
    const exporter = fileTraceExporter({ dir });
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const span = { id: 'root2', name: 'x', attributes: { big: BigInt(7), cyclic }, startTime: Date.now() };
    exporter.onSpanStart(span);
    exporter.onSpanEnd({ ...span, endTime: span.startTime });

    const [{ lines }] = traceFiles();
    expect(lines[0].attributes).toEqual({ big: '7', cyclic: { a: 1, self: '[Circular]' } });
  });
});
