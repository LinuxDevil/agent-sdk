import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SpendLog, summarizeSpend, type PassSpendSummary } from '../spendLog';
import type { PassRecord } from '../passRunner';

function record(over: Partial<PassRecord> = {}): PassRecord {
  return {
    kind: 'version_summary',
    key: 'k',
    workspaceId: 'ws-1',
    agentId: 'a1',
    model: null,
    outcome: 'completed',
    usage: null,
    costUsd: null,
    ms: 12,
    at: '2026-10-05T10:00:00.000Z',
    ...over,
  };
}

describe('SpendLog', () => {
  let dir: string;
  let file: string;
  let log: SpendLog;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-spend-'));
    file = path.join(dir, 'nested', 'spend.jsonl');
    log = new SpendLog(file);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per record and reads them back oldest first', async () => {
    await log.append(record({ key: 'first' }));
    await log.append(record({ key: 'second', outcome: 'failed' }));
    const records = await log.read();
    expect(records.map((r) => r.key)).toEqual(['first', 'second']);
    expect(records[1]!.outcome).toBe('failed');
    // One line per record - the file is append-only JSONL.
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('read(month) keeps only records whose `at` starts with the month', async () => {
    await log.append(record({ at: '2026-10-01T00:00:00.000Z' }));
    await log.append(record({ at: '2026-11-01T00:00:00.000Z' }));
    await log.append(record({ at: '2026-10-31T23:59:59.000Z' }));
    const oct = await log.read('2026-10');
    expect(oct).toHaveLength(2);
    expect(await log.read('2026-12')).toHaveLength(0);
    expect(await log.read()).toHaveLength(3);
  });

  it('reads a missing file as empty and skips corrupt lines', async () => {
    expect(await new SpendLog(path.join(dir, 'nope.jsonl')).read()).toEqual([]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record())}\nnot json\n{"broken"\n\n${JSON.stringify(record({ key: 'after' }))}\n`);
    const records = await log.read();
    expect(records.map((r) => r.key)).toEqual(['k', 'after']);
  });

  it('concurrent appends each land as one whole line', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => log.append(record({ key: `k${i}` }))));
    const records = await log.read();
    expect(records).toHaveLength(20);
    expect(new Set(records.map((r) => r.key)).size).toBe(20);
  });

  it('a failed append does not poison later appends', async () => {
    // A directory where the file should be makes appendFile fail (EISDIR).
    const blocker = path.join(dir, 'blocker');
    fs.mkdirSync(blocker);
    const bad = new SpendLog(blocker);
    await expect(bad.append(record())).rejects.toThrow();
    fs.rmdirSync(blocker);
    await expect(bad.append(record({ key: 'recovered' }))).resolves.toBeUndefined();
    expect((await bad.read()).map((r) => r.key)).toEqual(['recovered']);
  });
});

describe('summarizeSpend', () => {
  it('sums costUsd (null as 0), counts calls and breaks out per kind', () => {
    const records = [
      record({ kind: 'version_summary', costUsd: 0.5 }),
      record({ kind: 'version_summary', costUsd: null, outcome: 'failed' }),
      record({ kind: 'eval_judge', costUsd: 0.25 }),
      record({ kind: 'draft_review' }),
    ];
    const summary: PassSpendSummary = summarizeSpend(records, '2026-10');
    expect(summary.month).toBe('2026-10');
    expect(summary.calls).toBe(4);
    expect(summary.totalUsd).toBeCloseTo(0.75);
    expect(summary.byKind['version_summary']).toEqual({ calls: 2, costUsd: 0.5 });
    expect(summary.byKind['eval_judge']).toEqual({ calls: 1, costUsd: 0.25 });
    expect(summary.byKind['draft_review']).toEqual({ calls: 1, costUsd: 0 });
    expect(summary.byKind['prompt_suggestion']).toBeUndefined();
  });

  it('empty input summarizes to zero', () => {
    expect(summarizeSpend([], '2026-10')).toEqual({ month: '2026-10', totalUsd: 0, calls: 0, byKind: {} });
  });
});
