/**
 * M5a: `lousho traces` against the fixture directory src/traces/__fixtures__/traces,
 * with a fixed clock and no colour.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDuration, parseTracesArgs, runTraces } from './traces';

const fixtures = path.join(__dirname, '..', 'traces', '__fixtures__');
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

async function run(args: string[], options: { color?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const error = vi.spyOn(console, 'error').mockImplementation((text: unknown) => void err.push(String(text)));
  const code = await runTraces(args, { cwd: fixtures, now: NOW, color: options.color ?? false, log: (text) => out.push(text) });
  error.mockRestore();
  return { code, out: out.join('\n'), err: err.join('\n') };
}

afterEach(() => vi.restoreAllMocks());

describe('lousho traces (M5a)', () => {
  it('lists the recent traces, newest first', async () => {
    const { code, out } = await run(['--dir', 'traces']);
    expect(code).toBe(0);
    expect(out).toMatchInlineSnapshot(`
      "TIME    AGENT    DURATION  MODEL  TOOLS  TOKENS IN/OUT  COST       STATUS  ID
      1h ago  weather  5.71s     1      1      58/16          $0.000018  error   3f2b7d00-1111-4222-8333-444455556666
      2h ago  weather  1.65s     2      1      159/32         $0.000043  ok      3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f
      1d ago  lead     3.02s     3      1      220/44         $0.000064  ok      9e8d7c6b-5a49-4382-a170-f0e1d2c3b4a5"
    `);
  });

  it('--limit caps the list', async () => {
    const { out } = await run(['--dir', 'traces', '--limit', '1']);
    expect(out.split('\n')).toHaveLength(2);
  });

  it('prints one trace as a tree, by unique prefix', async () => {
    const { code, out } = await run(['9e8d', '--dir', 'traces']);
    expect(code).toBe(0);
    expect(out).toMatchInlineSnapshot(`
      "Trace 9e8d7c6b-5a49-4382-a170-f0e1d2c3b4a5  6 spans, 3.02s
      invoke_agent lead              |████████████████████████|     3.02s  $0.000064
      ├─ chat gpt-4o-mini            |█████                   |     596ms  openai/gpt-4o-mini  in 80 out 30  $0.000030
      ├─ execute_tool task           |    ██████████████      |     1.80s  tool task  $0.000012
      │  └─ invoke_agent researcher  |    ██████████████      |     1.79s  $0.000012
      │     └─ chat gpt-4o-mini      |    ██████████████      |     1.77s  openai/gpt-4o-mini  in 20 out 8  $0.000012
      └─ chat gpt-4o-mini            |                   █████|     600ms  openai/gpt-4o-mini  in 120 out 6  $0.000022"
    `);
  });

  it('marks a failed tool span as error, with its message', async () => {
    const { out } = await run(['3f2b', '--dir', 'traces']);
    expect(out).toContain('tool get_weather  error');
    expect(out).toContain('fetch failed: timeout after 5000ms');
  });

  it('--content prints the captured messages and tool arguments', async () => {
    const plain = await run(['3f2a', '--dir', 'traces']);
    expect(plain.out).not.toContain('input:');
    const { out } = await run(['3f2a', '--dir', 'traces', '--content']);
    expect(out).toContain('input: [{"role":"user","parts":[{"type":"text","content":"What is the weather in Paris?"}]}]');
    expect(out).toContain('args: {"city":"Paris"}');
    expect(out).toContain('result: "Sunny, 21 C"');
    expect(out).toContain('It is sunny and 21 C in Paris.');
  });

  it('--json prints the summaries, or the spans of one trace', async () => {
    const list = JSON.parse((await run(['--dir', 'traces', '--json'])).out);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ traceId: '3f2b7d00-1111-4222-8333-444455556666', status: 'error' });
    const spans = JSON.parse((await run(['3f2a', '--dir', 'traces', '--json'])).out);
    expect(spans.map((span: { name: string }) => span.name)[0]).toBe('invoke_agent weather');
  });

  it('an ambiguous prefix lists the matches and exits 1', async () => {
    const { code, err } = await run(['3f2', '--dir', 'traces']);
    expect(code).toBe(1);
    expect(err).toContain("'3f2' matches 2 traces");
    expect(err).toContain('3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f');
    expect(err).toContain('3f2b7d00-1111-4222-8333-444455556666');
  });

  it('an unknown id exits 1', async () => {
    const { code, err } = await run(['zzz', '--dir', 'traces']);
    expect(code).toBe(1);
    expect(err).toContain("no trace matches 'zzz'");
  });

  it('a missing directory prints a hint and exits 0', async () => {
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out).toBe('No traces in .lousho/traces. Add exporter: fileTraceExporter() to createAgent().');
  });

  it('colours only when asked', async () => {
    expect((await run(['--dir', 'traces'], { color: true })).out).toContain('\u001b[31merror');
    expect((await run(['--dir', 'traces'])).out).not.toContain('\u001b[');
  });

  it('--help prints the usage; a bad flag or --limit exits 2', async () => {
    expect((await run(['--help'])).out).toContain('Usage: lousho traces');
    expect((await run(['--nope'])).code).toBe(2);
    expect((await run(['--limit', '0'])).code).toBe(2);
    expect(() => parseTracesArgs(['a', 'b'])).toThrow(/unexpected argument 'b'/);
  });

  it('reads a trace recorded from a real model run (live-trace.jsonl): tokens, cost and the tool tree', async () => {
    const source = path.join(fixtures, 'live-trace.jsonl');
    const id = (JSON.parse(fs.readFileSync(source, 'utf-8').split('\n')[0]) as { traceId: string }).traceId;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-live-fixture-'));
    try {
      fs.mkdirSync(path.join(dir, '2026-10-02'));
      fs.copyFileSync(source, path.join(dir, '2026-10-02', `${id}.jsonl`));

      const list = await run(['--dir', dir]);
      expect(list.code).toBe(0);
      expect(list.out).toContain('weather');
      expect(list.out).toContain(id);
      expect(list.out).toMatch(/\$0\.0000\d+/);

      const tree = await run([id.slice(0, 8), '--dir', dir]);
      expect(tree.code).toBe(0);
      expect(tree.out).toContain('invoke_agent weather');
      expect(tree.out).toContain('execute_tool get_weather');
      expect(tree.out).toMatch(/chat openai\/gpt-4o-mini.*in \d+ out \d+/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats durations', () => {
    expect([formatDuration(12), formatDuration(1234), formatDuration(125_000)]).toEqual(['12ms', '1.23s', '2m 05s']);
  });
});

describe('lousho traces: hosted tools (N1a)', () => {
  it('a chat span names the tools the provider ran in it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traces-hosted-'));
    try {
      const id = '3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f';
      const source = path.join(fixtures, 'traces', '2026-10-01', `${id}.jsonl`);
      const lines = fs.readFileSync(source, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { attributes: Record<string, unknown> });
      const chat = lines.find((span) => span.attributes['gen_ai.operation.name'] === 'chat')!;
      chat.attributes['lousho.hosted_tool_calls'] = ['web_search'];
      fs.mkdirSync(path.join(dir, 'traces', '2026-10-01'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'traces', '2026-10-01', `${id}.jsonl`), lines.map((span) => JSON.stringify(span)).join('\n') + '\n');
      const out: string[] = [];
      const code = await runTraces(['3f2a', '--dir', 'traces'], { cwd: dir, now: NOW, color: false, log: (text) => out.push(text) });
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('provider ran web_search');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
