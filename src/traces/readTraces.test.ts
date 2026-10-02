/**
 * M5a: listTraces() and readTrace() over the fixture directory
 * (`__fixtures__/traces`: two traces on 2026-10-01 sharing the id prefix
 * `3f2`, one of them failed; one older trace with a sub-agent).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTraces, listTraces, readTrace } from './readTraces';

const dir = path.join(__dirname, '__fixtures__', 'traces');
const OK = '3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f';
const FAILED = '3f2b7d00-1111-4222-8333-444455556666';
const OLDER = '9e8d7c6b-5a49-4382-a170-f0e1d2c3b4a5';

describe('listTraces (M5a)', () => {
  it('lists the traces newest first', async () => {
    const traces = await listTraces({ dir });
    expect(traces.map((trace) => trace.traceId)).toEqual([FAILED, OK, OLDER]);
  });

  it('stops at the limit', async () => {
    expect((await listTraces({ dir, limit: 2 })).map((trace) => trace.traceId)).toEqual([FAILED, OK]);
    expect(await listTraces({ dir, limit: 1 })).toHaveLength(1);
  });

  it('sums tokens and counts calls; the cost is the root rollup', async () => {
    const [, ok, older] = await listTraces({ dir });
    expect(ok).toMatchObject({
      name: 'invoke_agent weather',
      agent: 'weather',
      durationMs: 1650,
      status: 'ok',
      modelCalls: 2,
      toolCalls: 1,
      inputTokens: 159,
      outputTokens: 32,
      costUsd: 0.0000431,
      file: path.join(dir, '2026-10-01', `${OK}.jsonl`),
    });
    // The sub-agent's chat and the `task` tool count; its cost is already in the root's.
    expect(older).toMatchObject({ agent: 'lead', modelCalls: 3, toolCalls: 1, inputTokens: 220, outputTokens: 44, costUsd: 0.000064 });
  });

  it("reports the root span's error status", async () => {
    const [failed] = await listTraces({ dir });
    expect(failed).toMatchObject({ traceId: FAILED, status: 'error', toolCalls: 1 });
  });

  it('returns [] for a directory that does not exist', async () => {
    expect(await listTraces({ dir: path.join(dir, 'missing') })).toEqual([]);
  });

  it('skips a torn last line and summarizes a trace whose root never ended', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-traces-'));
    try {
      fs.mkdirSync(path.join(tmp, '2026-10-02'));
      const line = { v: 1, traceId: 'root', id: 'child', parentId: 'root', name: 'chat m', startTime: 100, endTime: 300, attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 3 } };
      fs.writeFileSync(path.join(tmp, '2026-10-02', 'root.jsonl'), `${JSON.stringify(line)}\n{"v":1,"traceId":"ro`);

      const [summary] = await listTraces({ dir: tmp });
      expect(summary).toMatchObject({ traceId: 'root', name: 'chat m', durationMs: 200, modelCalls: 1, inputTokens: 3 });
      expect(summary.costUsd).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('readTrace (M5a)', () => {
  it('reads a trace by id, spans by start time', async () => {
    const spans = await readTrace(OK, { dir });
    expect(spans.map((span) => span.name)).toEqual([
      'invoke_agent weather',
      'chat gpt-4o-mini',
      'execute_tool get_weather',
      'chat gpt-4o-mini',
    ]);
    expect(spans[0].parentId).toBeUndefined();
    expect(spans[1]).toMatchObject({ parentId: OK, kind: 'client', startTime: expect.any(Number), endTime: expect.any(Number) });
  });

  it('accepts a unique prefix', async () => {
    expect(await readTrace('3f2a', { dir })).toHaveLength(4);
    expect(findTraces('9e8', { dir })).toEqual([{ traceId: OLDER, file: path.join(dir, '2026-09-30', `${OLDER}.jsonl`) }]);
  });

  it('rejects an ambiguous prefix and resolves [] for an unknown one', async () => {
    await expect(readTrace('3f2', { dir })).rejects.toThrow(/matches 2 traces/);
    expect(findTraces('3f2', { dir }).map((match) => match.traceId).sort()).toEqual([OK, FAILED]);
    expect(await readTrace('nope', { dir })).toEqual([]);
    expect(findTraces('', { dir })).toEqual([]);
  });
});
