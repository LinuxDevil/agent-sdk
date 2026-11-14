import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Span, TraceExporter } from '@linuxdevil/lousho/traces';
import {
  PassOutputError,
  PassRefusedError,
  PassRunner,
  PassSkippedError,
  PassUnavailableError,
  type PassJob,
  type PassRecord,
} from '../passRunner';
import { SpendLog } from '../spendLog';

/** Collects every span the runner reports, start and end. */
function collectingExporter(spans: Span[] = []): TraceExporter {
  return {
    onSpanStart: (span) => spans.push({ ...span, attributes: { ...span.attributes } }),
    onSpanEnd: (span) => {
      const at = spans.findIndex((s) => s.id === span.id);
      if (at >= 0) spans[at] = { ...span, attributes: { ...span.attributes } };
      else spans.push({ ...span, attributes: { ...span.attributes } });
    },
  };
}

const JOB = { kind: 'version_summary', key: 'k', workspaceId: 'ws-1', agentId: 'agent-1' } as const;

function job<T>(run: PassJob<T>['run'], over: Partial<PassJob<T>> = {}): PassJob<T> {
  return { ...JOB, run, ...over } as PassJob<T>;
}

describe('PassRunner', () => {
  let dir: string;
  let spendLog: SpendLog;
  let spans: Span[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-passes-'));
    spendLog = new SpendLog(path.join(dir, 'spend.jsonl'));
    spans = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runner(over: Partial<ConstructorParameters<typeof PassRunner>[0]> = {}) {
    return new PassRunner({
      baseDir: dir,
      backoffMs: [1, 1],
      spendLog,
      exporter: collectingExporter(spans),
      ...over,
    });
  }

  const records = () => spendLog.read();

  it('dedupes the same kind:key while queued or running - one run, one promise result', async () => {
    const r = runner();
    let calls = 0;
    const run = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'done';
    };
    const [a, b] = await Promise.all([r.enqueue(job(run)), r.enqueue(job(run))]);
    expect(calls).toBe(1);
    expect(a).toEqual({ ok: true, value: 'done' });
    expect(b).toEqual(a);
    await r.idle();
  });

  it('runs a different key concurrently with the first', async () => {
    const r = runner();
    const keys: string[] = [];
    const run = async () => {
      keys.push('x');
      return keys.length;
    };
    await Promise.all([r.enqueue(job(run, { key: 'a' })), r.enqueue(job(run, { key: 'b' }))]);
    expect(keys).toHaveLength(2);
  });

  it('holds a third job until a slot frees at concurrency 2', async () => {
    const r = runner({ concurrency: 2 });
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const make = (key: string) =>
      job(async () => {
        started.push(key);
        await new Promise<void>((resolve) => gates.push(resolve));
        return key;
      }, { key });
    const results = [r.enqueue(make('a')), r.enqueue(make('b')), r.enqueue(make('c'))];
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started.sort()).toEqual(['a', 'b']);
    gates[0]!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toContain('c');
    gates[1]!();
    gates[2]!();
    await Promise.all(results);
    await r.idle();
  });

  it('retries a twice-failing job then succeeds, writing one completed record', async () => {
    const r = runner();
    let calls = 0;
    const result = await r.enqueue(
      job(async (ctx) => {
        calls += 1;
        ctx.record({ model: 'm1', usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01 });
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      })
    );
    expect(result).toEqual({ ok: true, value: 'ok' });
    expect(calls).toBe(3);
    const recs = await records();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      kind: 'version_summary',
      key: 'k',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      outcome: 'completed',
      model: 'm1',
      usage: { inputTokens: 30, outputTokens: 15 },
      costUsd: 0.03,
    });
    expect(recs[0]!.failure).toBeUndefined();
    expect(typeof recs[0]!.at).toBe('string');
    expect(recs[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ['unavailable', PassUnavailableError],
    ['refused', PassRefusedError],
    ['skipped', PassSkippedError],
  ] as const)('settles %s after one attempt with no retry', async (outcome, ErrorClass) => {
    const r = runner();
    let calls = 0;
    const result = await r.enqueue(
      job(async () => {
        calls += 1;
        throw new ErrorClass('nope');
      })
    );
    expect(calls).toBe(1);
    expect(result).toEqual({ ok: false, outcome, error: 'nope' });
    const recs = await records();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.outcome).toBe(outcome);
  });

  it.each([
    ['timeout', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['rate_limited', Object.assign(new Error('slow down'), { status: 429 })],
    ['rate_limited', new Error('HTTP 429 too many requests')],
    ['auth', Object.assign(new Error('bad key'), { status: 401 })],
    ['auth', Object.assign(new Error('no key'), { code: 'LOUSHO_PROVIDER_MISSING_API_KEY' })],
    ['invalid_output', new PassOutputError('bad json')],
    ['provider', new Error('boom')],
  ])('classifies a final failure as %s', async (failure, error) => {
    const r = runner();
    const result = await r.enqueue(job(async () => Promise.reject(error)));
    expect(result.ok).toBe(false);
    const recs = await records();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ outcome: 'failed', failure });
  });

  it('accumulates usage and cost across attempts', async () => {
    const r = runner();
    let calls = 0;
    await r.enqueue(
      job(async (ctx) => {
        calls += 1;
        ctx.record({ usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0.001 });
        if (calls === 1) throw new Error('retry me');
        return 'done';
      })
    );
    const recs = await records();
    expect(recs[0]).toMatchObject({
      outcome: 'completed',
      usage: { inputTokens: 2, outputTokens: 4 },
      costUsd: 0.002,
    });
  });

  it('appends one record and ends one pass.<kind> span per settled pass', async () => {
    const r = runner();
    await r.enqueue(job(async () => 'v'));
    await r.enqueue(job(async () => Promise.reject(new PassUnavailableError('off')), { key: 'other' }));
    const recs = await records();
    expect(recs).toHaveLength(2);
    const ended = spans.filter((s) => s.endTime !== undefined);
    // The disabled/skipped-immediate path writes a record without a span;
    // both of these ran, so both spanned.
    expect(ended.map((s) => s.name).sort()).toEqual(['pass.version_summary', 'pass.version_summary']);
    expect(ended[0]!.attributes['lousho.pass.kind']).toBe('version_summary');
    expect(ended.map((s) => s.attributes['lousho.pass.outcome']).sort()).toEqual(['completed', 'unavailable']);
  });

  it('resolves skipped without running when the kind is disabled', async () => {
    const r = runner({ isEnabled: (kind) => kind !== 'version_summary' });
    let calls = 0;
    const result = await r.enqueue(job(async () => (calls += 1)));
    expect(result).toEqual({ ok: false, outcome: 'skipped', error: 'Turned off in settings' });
    expect(calls).toBe(0);
    const recs = await records();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ outcome: 'skipped', ms: 0 });
  });

  it('close() aborts the running job signal and settles queued jobs as skipped', async () => {
    const r = runner({ concurrency: 1 });
    let queuedRan = false;
    const running = r.enqueue(
      job(
        (ctx) =>
          new Promise<never>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          })
      )
    );
    const queued = r.enqueue(
      job(async () => {
        queuedRan = true;
        return 'never';
      }, { key: 'queued' })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    r.close();
    const [runningResult, queuedResult] = await Promise.all([running, queued]);
    expect(queuedRan).toBe(false);
    expect(queuedResult).toMatchObject({ ok: false, outcome: 'skipped' });
    expect(runningResult.ok).toBe(false);
    const recs = await records();
    expect(recs.map((r2) => r2.outcome).sort()).toEqual(['failed', 'skipped']);
  });

  it('enqueue after close settles skipped', async () => {
    const r = runner();
    r.close();
    const result = await r.enqueue(job(async () => 'late'));
    expect(result).toMatchObject({ ok: false, outcome: 'skipped' });
  });

  it('an exporter that throws never fails the pass', async () => {
    const r = runner({
      exporter: {
        onSpanStart: () => {
          throw new Error('exporter down');
        },
        onSpanEnd: () => {
          throw new Error('exporter down');
        },
      },
    });
    const result = await r.enqueue(job(async () => 'fine'));
    expect(result).toEqual({ ok: true, value: 'fine' });
    expect(await records()).toHaveLength(1);
  });

  it('a spend log that throws never fails the pass', async () => {
    const bad = {
      append: () => Promise.reject(new Error('disk full')),
      read: () => Promise.resolve([] as PassRecord[]),
    } as unknown as SpendLog;
    const r = runner({ spendLog: bad });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await r.enqueue(job(async () => 'fine'));
    expect(result).toEqual({ ok: true, value: 'fine' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
