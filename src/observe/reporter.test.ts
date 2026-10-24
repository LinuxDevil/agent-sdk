/**
 * The reporter's contract: finished spans become `observation` events
 * (span.id is obs_id, parentage gives the trace), flushes are size/interval/
 * exit-triggered and serialized, an unreachable daemon or a full buffer
 * drops-and-counts without ever throwing into the run, and the env
 * (`LOUSHO_OBSERVE`) wiring composes with an explicit exporter.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenAiAttr, GenAiOperation, LegacyAttr, SdkAttr } from '../execution/semconv';
import type { Span, TraceExporter } from '../execution/tracing';
import { blockingPost } from './blockingPost';
import type { IngestEvent } from './envelope';
import { fanOutExporters, observeExporter, observeExporterFromEnv, queueObserveEvents, withObserveExporter, type ObserveReporter } from './reporter';

interface PostedBatch {
  url: string;
  authorization?: string;
  events: IngestEvent[];
}

/** A fetch mock that records every batch and answers 202 (or `fail`, to emulate a dead daemon). */
function mockFetch(fail = false): { fetchFn: typeof fetch; posted: PostedBatch[] } {
  const posted: PostedBatch[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { batch: IngestEvent[] };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    posted.push({ url, authorization: headers.authorization, events: body.batch });
    return new Response('{}', { status: fail ? 500 : 202 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, posted };
}

const reporters: ObserveReporter[] = [];
let cwd: string;

function makeSpan(over: Partial<Span> = {}): Span {
  return { id: `s${Math.random().toString(36).slice(2)}`, name: 'invoke_agent a', attributes: {}, startTime: 100, endTime: 150, ...over };
}

function reporter(over: Parameters<typeof observeExporter>[0] = {}, fail = false): { r: ObserveReporter; posted: PostedBatch[] } {
  const { fetchFn, posted } = mockFetch(fail);
  const r = observeExporter({
    cwd,
    url: 'http://127.0.0.1:1',
    project: 'testproj',
    agentName: 'agent-a',
    flushIntervalMs: 0,
    heartbeatIntervalMs: 0,
    registerExitHooks: false,
    fetchFn,
    ...over,
  });
  reporters.push(r);
  return { r, posted };
}

const allEvents = (posted: PostedBatch[]): IngestEvent[] => posted.flatMap((p) => p.events);
const observations = (posted: PostedBatch[]) =>
  allEvents(posted).filter((e): e is Extract<IngestEvent, { type: 'observation' }> => e.type === 'observation');
/** Finished-span events only: a root span's start also posts an observation, one without `end`. */
const finished = (posted: PostedBatch[]) => observations(posted).filter((o) => o.data.end !== undefined);
// The queue-mechanics tests below finish root spans through onSpanEnd alone: an
// onSpanStart would add the root's eager start event and its own flush (see 'eager root start').

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-reporter-'));
});

afterEach(async () => {
  await Promise.all(reporters.splice(0).map((r) => r.close().catch(() => undefined)));
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('observeExporter', () => {
  it('emits one observation per finished span, trace-grouped by parentage', async () => {
    const { r, posted } = reporter();
    const root = makeSpan({ id: 'root', attributes: { [GenAiAttr.OPERATION_NAME]: GenAiOperation.INVOKE_AGENT } });
    const child = makeSpan({
      id: 'child',
      parentId: 'root',
      name: 'execute_tool x',
      startTime: 110,
      endTime: 130,
      status: { code: 'ok' },
      attributes: { [GenAiAttr.OPERATION_NAME]: GenAiOperation.EXECUTE_TOOL, [GenAiAttr.TOOL_CALL_ARGUMENTS]: '{"a":1}', [GenAiAttr.TOOL_CALL_RESULT]: 'done' },
    });
    r.onSpanStart(root);
    r.onSpanStart(child);
    r.onSpanEnd(child);
    r.onSpanEnd(root);
    await r.close();

    const obs = finished(posted);
    expect(obs).toHaveLength(2);
    const byRoot = obs.find((o) => o.data.obs_id === 'root')?.data;
    const byChild = obs.find((o) => o.data.obs_id === 'child')?.data;
    expect(byRoot?.trace_id).toBe('root');
    expect(byChild?.trace_id).toBe('root');
    expect(byChild?.parent_obs_id).toBe('root');
    expect(byChild?.kind).toBe('tool');
    expect(byChild?.input).toBe('{"a":1}');
    expect(byChild?.output).toBe('done');
    expect(byChild?.agent_id).toBe(r.agentId);
    expect(byChild?.session_id).toBe(r.sessionId);
    // the final batch ends with the deregister event
    expect(allEvents(posted).at(-1)?.type).toBe('agent.deregister');
  });

  it('maps an ended span with unset status to ok', async () => {
    const { r, posted } = reporter();
    const span = makeSpan({ id: 'ended', endTime: 150 });
    r.onSpanStart(span);
    r.onSpanEnd(span);
    await r.close();
    expect(finished(posted).find((o) => o.data.obs_id === 'ended')?.data.status).toBe('ok');
  });

  it('keeps an open span status unset', async () => {
    const { r, posted } = reporter();
    const span = makeSpan({ id: 'open', endTime: undefined });
    r.onSpanStart(span);
    r.onSpanEnd(span);
    await r.close();
    expect(finished(posted).find((o) => o.data.obs_id === 'open')?.data.status).toBeUndefined();
  });

  it('carries usage/cost/flags verbatim from gen_ai + lousho attrs', async () => {
    const { r, posted } = reporter();
    const span = makeSpan({
      id: 'chat1',
      attributes: {
        [GenAiAttr.OPERATION_NAME]: GenAiOperation.CHAT,
        [GenAiAttr.RESPONSE_MODEL]: 'm-1',
        [GenAiAttr.USAGE_INPUT_TOKENS]: 100,
        [GenAiAttr.USAGE_OUTPUT_TOKENS]: 40,
        'gen_ai.usage.cached_input_tokens': 30,
        [SdkAttr.USAGE_REASONING_TOKENS]: 12,
        [SdkAttr.COST_USD]: 0.007,
        'lousho.cost_partial': true,
        [SdkAttr.USAGE_ESTIMATED]: true,
        [GenAiAttr.CONVERSATION_ID]: 'real-session',
      },
    });
    r.onSpanStart(span);
    r.onSpanEnd(span);
    await r.close();

    const d = finished(posted)[0].data;
    expect(d.kind).toBe('generation');
    expect(d.model).toBe('m-1');
    expect(d.usage_input_tokens).toBe(100);
    expect(d.usage_output_tokens).toBe(40);
    expect(d.usage_cached_tokens).toBe(30);
    expect(d.usage_reasoning_tokens).toBe(12);
    expect(d.cost_usd).toBe(0.007);
    expect(d.cost_partial).toBe(true);
    expect(d.usage_estimated).toBe(true);
    // a real conversation id beats the fallback session
    expect(d.session_id).toBe('real-session');
  });

  it('falls back to legacy attribute names', async () => {
    const { r, posted } = reporter();
    const span = makeSpan({ id: 'legacy', attributes: { [LegacyAttr.MODEL]: 'old-m', [LegacyAttr.PROMPT_TOKENS]: 9, input: 'hi', result: 'yo' } });
    r.onSpanStart(span);
    r.onSpanEnd(span);
    await r.close();
    const d = finished(posted)[0].data;
    expect(d.model).toBe('old-m');
    expect(d.usage_input_tokens).toBe(9);
    expect(d.input).toBe('hi');
    expect(d.output).toBe('yo');
  });

  it('flushes when the buffer reaches flushSize', async () => {
    const { r, posted } = reporter({ flushSize: 3 });
    for (let i = 0; i < 3; i++) {
      const span = makeSpan({ id: `s${i}` });
      r.onSpanEnd(span);
    }
    // the size flush is chained microtask work - one turn is enough
    await vi.waitFor(() => expect(observations(posted)).toHaveLength(3));
    await r.close();
  });

  it('drops and counts when the daemon is unreachable, warning once, never throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { r, posted } = reporter({}, true);
      const span = makeSpan();
      r.onSpanStart(span);
      r.onSpanEnd(span);
      await expect(r.close()).resolves.toBeUndefined();
      expect(r.dropped).toBeGreaterThanOrEqual(1);
      expect(posted.length).toBeGreaterThanOrEqual(1); // the POST was attempted
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('drops events past maxBuffered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { r } = reporter({ maxBuffered: 2, flushSize: 100 }, true);
      for (let i = 0; i < 5; i++) {
        const span = makeSpan();
        r.onSpanEnd(span);
      }
      expect(r.dropped).toBe(3);
      await r.close();
    } finally {
      warn.mockRestore();
    }
  });

  describe('requeue with backoff', () => {
    /** A fetch whose n-th call answers `outcomes[n]` (the last outcome repeats); every attempt is recorded. */
    function scriptedFetch(outcomes: Array<'fail' | 'ok'>): { fetchFn: typeof fetch; posted: PostedBatch[] } {
      const posted: PostedBatch[] = [];
      const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body)) as { batch: IngestEvent[] };
        const outcome = outcomes[Math.min(posted.length, outcomes.length - 1)];
        posted.push({ url: String(input), events: body.batch });
        if (outcome === 'fail') throw new TypeError('fetch failed');
        return new Response('{}', { status: 202 });
      });
      return { fetchFn: fetchFn as unknown as typeof fetch, posted };
    }

    const emit = (r: ObserveReporter, ids: string[]) => {
      for (const id of ids) {
        const span = makeSpan({ id });
        r.onSpanEnd(span);
      }
    };

    const silenceWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let warn: ReturnType<typeof silenceWarn>;
    beforeEach(() => {
      vi.useFakeTimers();
      warn = silenceWarn();
    });
    afterEach(() => {
      vi.useRealTimers();
      warn.mockRestore();
    });

    it('requeues a failed batch and delivers it on the next flush', async () => {
      const { fetchFn, posted } = scriptedFetch(['fail', 'ok']);
      const { r } = reporter({ fetchFn, flushIntervalMs: 1000 });
      emit(r, ['a', 'b', 'c']);
      await vi.advanceTimersByTimeAsync(1000); // first flush: rejected
      expect(posted).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000); // second flush, after the 1s backoff
      expect(posted).toHaveLength(2);
      expect(posted[1]!.events).toHaveLength(3);
      expect(posted[1]!.events.map((e) => e.type === 'observation' && e.data.obs_id)).toEqual(['a', 'b', 'c']);
      expect(r.dropped).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('evicts oldest events past maxBuffered and counts them', async () => {
      const { fetchFn, posted } = scriptedFetch(['fail']);
      const { r } = reporter({ fetchFn, maxBuffered: 4, flushIntervalMs: 1000 });
      emit(r, ['s0', 's1', 's2', 's3', 's4', 's5']);
      await vi.advanceTimersByTimeAsync(1000); // flush: rejected, requeued
      expect(r.dropped).toBe(2);
      await vi.advanceTimersByTimeAsync(1000); // the retry carries what is still pending
      expect(posted).toHaveLength(2);
      expect(posted[1]!.events.map((e) => e.type === 'observation' && e.data.obs_id)).toEqual(['s2', 's3', 's4', 's5']);
      expect(r.dropped).toBe(2);
    });

    it('trims a requeued batch from the front when new events arrived during the failed POST', async () => {
      const posted: PostedBatch[] = [];
      let reject!: (error: Error) => void;
      const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        posted.push({ url: String(input), events: (JSON.parse(String(init?.body)) as { batch: IngestEvent[] }).batch });
        if (posted.length === 1) return new Promise<Response>((_, rej) => (reject = rej));
        return new Response('{}', { status: 202 });
      }) as unknown as typeof fetch;
      const { r } = reporter({ fetchFn, maxBuffered: 4, flushSize: 3, flushIntervalMs: 1000 });
      emit(r, ['a', 'b', 'c']); // size flush: in flight
      await vi.advanceTimersByTimeAsync(0);
      emit(r, ['d', 'e']); // arrive while the POST hangs
      reject(new TypeError('fetch failed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(r.dropped).toBe(1); // a, b, c, d, e requeued into 4 slots: the oldest goes
      await vi.advanceTimersByTimeAsync(1000);
      expect(posted.at(-1)!.events.map((e) => e.type === 'observation' && e.data.obs_id)).toEqual(['b', 'c', 'd', 'e']);
      expect(r.dropped).toBe(1);
    });

    it('backs off between failed attempts', async () => {
      const { fetchFn, posted } = scriptedFetch(['fail']);
      const { r } = reporter({ fetchFn, flushIntervalMs: 100, flushSize: 2 });
      emit(r, ['a']);
      await vi.advanceTimersByTimeAsync(100); // attempt 1
      expect(posted).toHaveLength(1);
      let failedAt = Date.now();
      // n = failures so far - 1: 1s, 2s, 4s, 8s, 16s, then the 30s cap
      for (let n = 0; n < 7; n++) {
        const retryAt = failedAt + Math.min(2 ** n * 1000, 30_000);
        emit(r, [`x${n}`, `y${n}`]); // a size flush inside the window must not retry either
        await vi.advanceTimersByTimeAsync(retryAt - 1 - Date.now());
        expect(posted).toHaveLength(n + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(posted).toHaveLength(n + 2);
        failedAt = Date.now();
      }
      expect(r.dropped).toBe(0);
    });

    it('flush() sends at once even while backing off, and a failure there is requeued', async () => {
      const { fetchFn, posted } = scriptedFetch(['fail', 'fail', 'ok']);
      const { r } = reporter({ fetchFn, flushIntervalMs: 1000 });
      emit(r, ['a']);
      await vi.advanceTimersByTimeAsync(1000); // rejected; the interval waits until t=2000
      await r.flush(); // explicit: no backoff wait, fails again, requeued
      expect(posted).toHaveLength(2);
      await r.flush();
      expect(posted).toHaveLength(3);
      expect(posted[2]!.events.map((e) => e.type === 'observation' && e.data.obs_id)).toEqual(['a']);
      expect(r.dropped).toBe(0);
    });

    it('queueObserveEvents() puts non-span events behind the spans queued before them, retried with them', async () => {
      const { fetchFn, posted } = scriptedFetch(['fail', 'ok']);
      const { r } = reporter({ fetchFn });
      emit(r, ['span-1']);
      const score: IngestEvent = { type: 'score', data: { score_id: 'sc', trace_id: 'span-1', name: 'e/a', value: 1, source: 'eval', ts: 1 } };
      expect(queueObserveEvents(r, [score])).toBe(true);
      await r.flush();
      await r.flush();
      expect(posted[1]!.events.map((e) => e.type)).toEqual(['observation', 'score']);
      expect(queueObserveEvents({} as ObserveReporter, [score])).toBe(false);
    });

    it('close() makes one final attempt despite the backoff and counts leftovers as dropped', async () => {
      const { fetchFn, posted } = scriptedFetch(['fail']);
      const { r } = reporter({ fetchFn, flushIntervalMs: 1000 });
      emit(r, ['a', 'b']);
      await vi.advanceTimersByTimeAsync(1000); // rejected; next attempt not before t=2000
      expect(r.dropped).toBe(0);
      await r.close();
      expect(posted).toHaveLength(2);
      expect(posted[1]!.events.map((e) => e.type)).toEqual(['observation', 'observation', 'agent.deregister']);
      expect(r.dropped).toBe(3);
    });

    it('drains a backlog past the daemon batch cap in successive capped batches, and the flush chain survives', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        const sizes: number[] = [];
        const ids: string[] = [];
        const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const batch = (JSON.parse(String(init?.body)) as { batch: IngestEvent[] }).batch;
          sizes.push(batch.length);
          if (sizes.length === 1) throw new TypeError('fetch failed'); // the daemon is down
          for (const e of batch) if (e.type === 'observation') ids.push(e.data.obs_id);
          return new Response('{}', { status: 202 });
        }) as unknown as typeof fetch;
        const total = 2500;
        const { r } = reporter({ fetchFn, flushSize: total + 1, flushIntervalMs: 1000 });
        for (let i = 0; i < total; i++) r.onSpanEnd({ id: `s${i}`, name: 'n', attributes: {}, startTime: 1, endTime: 2 });
        await vi.advanceTimersByTimeAsync(1000); // rejected: the oldest 1000 are requeued
        await vi.advanceTimersByTimeAsync(1000); // the daemon is back: one flush drains it all, batch after batch
        expect(sizes).toEqual([1000, 1000, 1000, 500]);
        expect(ids).toEqual(Array.from({ length: total }, (_, i) => `s${i}`)); // every event, oldest first
        expect(r.dropped).toBe(0);
        await r.close();
        expect(sizes).toHaveLength(5); // the chain still runs close()'s flush (the deregister)
        await vi.advanceTimersByTimeAsync(10); // let any stray rejection surface
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it("close()'s final attempt sends a backlog in capped batches and drops the rest when one fails", async () => {
      const sizes: number[] = [];
      const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        sizes.push((JSON.parse(String(init?.body)) as { batch: IngestEvent[] }).batch.length);
        return new Response('{}', { status: sizes.length === 2 ? 500 : 202 });
      }) as unknown as typeof fetch;
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { r } = reporter({ fetchFn, flushSize: 10_000 });
      for (let i = 0; i < 2500; i++) r.onSpanEnd({ id: `s${i}`, name: 'n', attributes: {}, startTime: 1, endTime: 2 });
      await r.close();
      expect(sizes).toEqual([1000, 1000]); // the second failed: it and the remaining 501 (500 + the deregister) are dropped
      expect(r.dropped).toBe(1501);
    });
  });

  describe('byte cap', () => {
    const BUDGET = 4 * 1024 * 1024; // BATCH_BUDGET_BYTES
    /** A finished span whose input is `bytes` of ASCII. */
    const bigSpan = (id: string, bytes: number): Span =>
      makeSpan({ id, attributes: { [GenAiAttr.OPERATION_NAME]: GenAiOperation.CHAT, [GenAiAttr.INPUT_MESSAGES]: 'x'.repeat(bytes) } });
    /** A fetch that records each body's size and ids, answering `status(n)` to the n-th call (1-based). */
    function sizedFetch(status: (n: number) => number = () => 202) {
      const calls: { bytes: number; ids: string[] }[] = [];
      const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = String(init?.body);
        const batch = (JSON.parse(body) as { batch: IngestEvent[] }).batch;
        calls.push({ bytes: Buffer.byteLength(body), ids: batch.flatMap((e) => (e.type === 'observation' ? [e.data.obs_id] : [])) });
        return new Response('{}', { status: status(calls.length) });
      }) as unknown as typeof fetch;
      return { fetchFn, calls };
    }

    it('cuts batches of large events at the byte budget, all delivered in order', async () => {
      const { fetchFn, calls } = sizedFetch();
      const { r } = reporter({ fetchFn, flushSize: 1000 });
      for (let i = 0; i < 50; i++) {
        const span = bigSpan(`big${i}`, 200 * 1024);
        r.onSpanEnd(span);
      }
      await r.close();
      expect(calls.length).toBeGreaterThanOrEqual(3); // ~10MB of events
      for (const call of calls) expect(call.bytes).toBeLessThanOrEqual(BUDGET);
      expect(calls.flatMap((c) => c.ids)).toEqual(Array.from({ length: 50 }, (_, i) => `big${i}`));
      expect(r.dropped).toBe(0);
    });

    it('evicts the oldest events past the 32MB outbox byte budget and counts them', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      let down = true;
      const { fetchFn, calls } = sizedFetch(() => (down ? 500 : 202));
      const { r } = reporter({ fetchFn, flushSize: 10_000 });
      // ~2MB per event (the input rides twice: input + attrs) x 24 = ~48MB, well under the 5000-event cap.
      for (let i = 0; i < 24; i++) r.onSpanEnd(bigSpan(`big${i}`, 1024 * 1024));
      expect(r.dropped).toBeGreaterThanOrEqual(7);
      expect(r.dropped).toBeLessThanOrEqual(9);
      const kept = 24 - r.dropped;
      down = false;
      await r.flush();
      await r.flush();
      expect(calls.flatMap((c) => c.ids)).toEqual(Array.from({ length: kept }, (_, i) => `big${24 - kept + i}`));
    });

    it('drops and counts one event too large for any request, and keeps delivering', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { fetchFn, calls } = sizedFetch();
      const { r } = reporter({ fetchFn, flushSize: 1000 });
      for (const span of [bigSpan('huge', 6 * 1024 * 1024), makeSpan({ id: 'after' })]) {
        r.onSpanEnd(span);
      }
      expect(r.dropped).toBe(1);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toMatch(/larger than the daemon's 5242880-byte request cap/);
      await r.close();
      expect(calls.flatMap((c) => c.ids)).toEqual(['after']);
      expect(r.dropped).toBe(1);
    });

    it('sends one event over the budget but under the hard cap on its own', async () => {
      // The input is carried twice (input + attrs): ~4.4MB of event, over the 4MB budget, under the 5MB cap.
      const { fetchFn, calls } = sizedFetch();
      const { r } = reporter({ fetchFn, flushSize: 1000 });
      for (const span of [makeSpan({ id: 'before' }), bigSpan('large', 2.2 * 1024 * 1024), makeSpan({ id: 'after' })]) {
        r.onSpanEnd(span);
      }
      await r.close();
      expect(calls.map((c) => c.ids)).toEqual([['before'], ['large'], ['after']]);
      expect(r.dropped).toBe(0);
    });

    it('drops and counts a batch the daemon answers 413, and keeps delivering', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { fetchFn, calls } = sizedFetch((n) => (n === 1 ? 413 : 202));
      const { r } = reporter({ fetchFn, flushSize: 2 });
      const finish = (id: string) => {
        const span = makeSpan({ id });
        r.onSpanEnd(span);
      };
      finish('a');
      finish('b'); // a size flush: answered 413
      await vi.waitFor(() => expect(r.dropped).toBe(2));
      finish('c');
      finish('d');
      await r.close();
      expect(calls[0].ids).toEqual(['a', 'b']);
      expect(calls.flatMap((c) => c.ids)).toEqual(['a', 'b', 'c', 'd']); // the refused batch is not resent
      expect(r.dropped).toBe(2); // the refused batch, not requeued
      expect(String(warn.mock.calls[0][0])).toContain('refused a batch of 2 events (413)');
    });

    it('warns about a drop without promising a retry, and still warns about a later outage', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { fetchFn } = sizedFetch((n) => (n === 1 ? 413 : 503));
      const { r } = reporter({ fetchFn, flushSize: 1000 });
      r.onSpanEnd(makeSpan({ id: 'refused' }));
      await r.flush(); // 413: dropped
      r.onSpanEnd(makeSpan({ id: 'later' }));
      await r.flush(); // 503: an outage, requeued
      expect(warn).toHaveBeenCalledTimes(2);
      const [drop, outage] = warn.mock.calls.map((call) => String(call[0]));
      expect(drop).toContain('refused a batch');
      expect(drop).not.toContain('retrying');
      expect(outage).toContain('could not reach the observe daemon');
      expect(outage).toContain('retrying with backoff');
    });
  });

  it('clamps maxBuffered to 1 so the deregister survives', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { r, posted } = reporter({ maxBuffered: 0 });
      const span = makeSpan();
      r.onSpanEnd(span); // fits in the single slot
      await r.close(); // the deregister evicts it
      expect(allEvents(posted).map((e) => e.type)).toEqual(['agent.deregister']);
      expect(r.dropped).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('close() aborts a regular flush in flight and sends its batch in the final attempt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const posted: PostedBatch[] = [];
      const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        posted.push({ url: String(input), events: (JSON.parse(String(init?.body)) as { batch: IngestEvent[] }).batch });
        if (posted.length > 1) return new Response('{}', { status: 202 });
        // The first POST hangs until its signal fires (a daemon that accepted the socket but never answers).
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
      }) as unknown as typeof fetch;
      const { r } = reporter({ fetchFn, flushSize: 1, requestTimeoutMs: 60_000 });
      const span = makeSpan({ id: 'hung' });
      r.onSpanEnd(span); // size flush: in flight, hanging
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      const started = Date.now();
      await r.close();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(posted).toHaveLength(2);
      expect(posted[1]!.events.map((e) => (e.type === 'observation' ? e.data.obs_id : e.type))).toEqual(['hung', 'agent.deregister']);
      expect(r.dropped).toBe(0);
      expect(warn).not.toHaveBeenCalled(); // a healthy daemon: no outage warning for the aborted flush
    } finally {
      warn.mockRestore();
    }
  });

  it('emits a heartbeat immediately when heartbeats are on', async () => {
    const { r, posted } = reporter({ heartbeatIntervalMs: 60_000 });
    await r.close();
    const hb = allEvents(posted).find((e) => e.type === 'agent.heartbeat');
    expect(hb).toBeDefined();
    expect(hb?.type === 'agent.heartbeat' && hb.data.project).toBe('testproj');
  });

  it('sends the bearer token when configured', async () => {
    const { r, posted } = reporter({ token: 'lso_abc' });
    const span = makeSpan();
    r.onSpanStart(span);
    r.onSpanEnd(span);
    await r.close();
    expect(posted.every((p) => p.authorization === 'Bearer lso_abc')).toBe(true);
  });

  it('persists agent_id + session_id across reporters in one project dir', async () => {
    const first = reporter();
    const second = reporter();
    expect(first.r.agentId).toBe(second.r.agentId);
    expect(first.r.sessionId).toBe(second.r.sessionId);
    await first.r.close();
    await second.r.close();
    // and across "restarts" via the identity file
    const file = path.join(cwd, '.lousho', 'identity', 'agent-a@testproj.json');
    expect(fs.existsSync(file)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { agent_id: string };
    expect(stored.agent_id).toBe(first.r.agentId);
  });

  it('close() is idempotent and posts the deregister exactly once', async () => {
    const { r, posted } = reporter();
    await r.close();
    await r.close();
    expect(allEvents(posted).filter((e) => e.type === 'agent.deregister')).toHaveLength(1);
  });

  describe('eager root start', () => {
    it('enqueues and flushes a root span start before the run ends', async () => {
      const { r, posted } = reporter();
      const root = makeSpan({ id: 'run', endTime: undefined, attributes: { [GenAiAttr.OPERATION_NAME]: GenAiOperation.INVOKE_AGENT } });
      r.onSpanStart(root);
      // no flushSize, no interval: only the eager flush can have sent it
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0].events).toHaveLength(1);
      const start = posted[0].events[0];
      expect(start.type).toBe('observation');
      const data = start.type === 'observation' ? start.data : undefined;
      expect(data).toMatchObject({ obs_id: 'run', trace_id: 'run', kind: 'span', start: 100, agent_id: r.agentId });
      // open: no end (stored as end NULL) and no status, so the run reads as running
      expect(data?.end ?? null).toBeNull();
      expect(data?.status).toBeUndefined();

      r.onSpanEnd({ ...root, endTime: 180 });
      await r.close();
      const ends = observations(posted).filter((o) => o.data.obs_id === 'run' && o.data.end !== undefined);
      expect(ends.map((o) => [o.data.end, o.data.status])).toEqual([[180, 'ok']]);
    });

    describe('with fake timers', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('sends no start event for a child span', async () => {
        const { r, posted } = reporter();
        r.onSpanStart(makeSpan({ id: 'root', endTime: undefined }));
        await vi.advanceTimersByTimeAsync(0);
        expect(posted).toHaveLength(1);
        r.onSpanStart(makeSpan({ id: 'child', parentId: 'root', endTime: undefined }));
        await vi.advanceTimersByTimeAsync(10_000); // past any interval a flush could hide behind
        expect(posted).toHaveLength(1);
        expect(observations(posted).map((o) => o.data.obs_id)).toEqual(['root']);
      });

      it('batches the start of runs begun together into one POST', async () => {
        const { r, posted } = reporter();
        for (const id of ['r1', 'r2', 'r3']) r.onSpanStart(makeSpan({ id, endTime: undefined }));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(posted).toHaveLength(1);
        expect(observations(posted).map((o) => o.data.obs_id)).toEqual(['r1', 'r2', 'r3']);
      });

      it('does not retry a down daemon early: the eager flush waits out the backoff', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          const { r, posted } = reporter({ flushIntervalMs: 100 }, true);
          r.onSpanStart(makeSpan({ id: 'first', endTime: undefined }));
          await vi.advanceTimersByTimeAsync(0);
          expect(posted).toHaveLength(1); // answered 500: backing off 1s
          r.onSpanStart(makeSpan({ id: 'second', endTime: undefined }));
          await vi.advanceTimersByTimeAsync(999);
          expect(posted).toHaveLength(1); // neither the eager flush nor the interval retried inside the backoff
          await vi.advanceTimersByTimeAsync(100);
          expect(posted).toHaveLength(2); // the interval retries after it, carrying both starts
          expect(posted[1].events.map((e) => e.type === 'observation' && e.data.obs_id)).toEqual(['first', 'second']);
          expect(r.dropped).toBe(0);
        } finally {
          warn.mockRestore();
        }
      });
    });

    it('stamps one per-process instance id on heartbeats, run roots and the deregister', async () => {
      const { r, posted } = reporter({ heartbeatIntervalMs: 60_000 });
      const root = makeSpan({ id: 'root', endTime: undefined });
      const child = makeSpan({ id: 'child', parentId: 'root' });
      r.onSpanStart(root);
      r.onSpanStart(child);
      r.onSpanEnd(child);
      r.onSpanEnd({ ...root, endTime: 200 });
      await r.close();
      const events = allEvents(posted);
      const hb = events.find((e) => e.type === 'agent.heartbeat');
      const instance = hb?.type === 'agent.heartbeat' ? hb.data.instance_id : undefined;
      expect(instance).toMatch(/^[0-9a-f-]{36}$/);
      const attrOf = (id: string) => observations(posted).filter((o) => o.data.obs_id === id).map((o) => o.data.attrs?.['lousho.instance_id']);
      expect(attrOf('root')).toEqual([instance, instance]); // the start and the end event
      expect(attrOf('child')).toEqual([undefined]);
      expect(root.attributes['lousho.instance_id']).toBeUndefined(); // the span itself is not touched
      const bye = events.find((e) => e.type === 'agent.deregister');
      expect(bye?.type === 'agent.deregister' && bye.data.instance_id).toBe(instance);
      // one process, one instance: another reporter here reports the same id
      const other = reporter({ heartbeatIntervalMs: 60_000 });
      await other.r.close();
      const hb2 = allEvents(other.posted).find((e) => e.type === 'agent.heartbeat');
      expect(hb2?.type === 'agent.heartbeat' && hb2.data.instance_id).toBe(instance);
      // realm-global: a second copy of this module (dual ESM/CJS load) reads the same id
      expect((globalThis as Record<symbol, unknown>)[Symbol.for('lousho.observeInstance')]).toBe(instance);
    });
  });

  it('counts a span ending after close() as dropped', async () => {
    const { r } = reporter();
    await r.close();
    const span = makeSpan();
    r.onSpanEnd(span);
    expect(r.dropped).toBe(1);
  });
});

describe('crash flush', () => {
  const fixture = path.join(__dirname, '__fixtures__', 'crashAfterRun.mts');
  const repoRoot = path.resolve(__dirname, '..', '..');
  type Mode = 'throw' | 'reject' | 'inflight' | 'handled' | 'capture' | 'backlog' | 'bigbacklog' | 'hugebacklog';

  /**
   * Run the fixture against an in-test collector; resolves with its exit and
   * the batch of every ingest request received. `holdFirst` never answers the
   * first request (a POST still in flight when the process dies).
   */
  async function crash(mode: Mode, holdFirst = false): Promise<{ code: number | null; stderr: string; batches: IngestEvent[][] }> {
    const batches: IngestEvent[][] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        if (req.url === '/api/v1/ingest') batches.push((JSON.parse(body) as { batch: IngestEvent[] }).batch);
        if (holdFirst && batches.length === 1) return;
        res.writeHead(202, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, mode], {
        cwd: repoRoot,
        env: { ...process.env, LOUSHO_OBSERVE: `http://127.0.0.1:${port}`, LOUSHO_FIXTURE_CWD: cwd },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      return { code, stderr, batches };
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  /** Finished spans' ids; the fixture's spans are run roots, so each also posts a start event (no `end`) first. */
  const obsIds = (batch: IngestEvent[]): string[] =>
    batch.flatMap((e) => (e.type === 'observation' && e.data.end !== undefined ? [e.data.obs_id] : []));
  /** Every observation, start events marked: `<id>:start` / `<id>:end`. */
  const obsEvents = (batch: IngestEvent[]): string[] =>
    batch.flatMap((e) => (e.type === 'observation' ? [`${e.data.obs_id}:${e.data.end === undefined ? 'start' : 'end'}`] : []));

  it('flushes pending events when the process dies of an uncaught exception', async () => {
    const { code, stderr, batches } = await crash('throw');
    expect(code).toBe(1); // Node's own crash exit code, unchanged
    expect(stderr).toContain('fixture: uncaught exception after run');
    expect(batches.flatMap(obsEvents)).toEqual(['crash-span:start', 'crash-span:end']);
    expect(batches.flat().map((e) => e.type)).toContain('agent.deregister');
  }, 30_000);

  it('flushes pending events when the process dies of an unhandled rejection', async () => {
    const { code, stderr, batches } = await crash('reject');
    expect(code).toBe(1);
    expect(stderr).toContain('fixture: unhandled rejection after run');
    expect(batches.flatMap(obsIds)).toEqual(['crash-span']);
  }, 30_000);

  it('sends a crash backlog past the daemon batch cap as successive capped POSTs', async () => {
    const { code, batches } = await crash('backlog');
    expect(code).toBe(1);
    expect(batches.map((b) => b.length)).toEqual([1000, 1000, 1000, 1]); // 1500 runs x (start + end) + the deregister, oldest first
    expect(batches.flatMap(obsIds)).toEqual(['crash-span', ...Array.from({ length: 1499 }, (_, i) => `crash-span-${i + 1}`)]);
  }, 30_000);

  it('cuts a crash backlog of large events at the byte budget', async () => {
    const { code, batches } = await crash('bigbacklog');
    expect(code).toBe(1);
    expect(batches.length).toBeGreaterThanOrEqual(3); // 31 runs x (start + end) x 2 copies of ~100KB = ~12MB
    for (const batch of batches) expect(Buffer.byteLength(JSON.stringify({ batch }))).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(batches.flatMap(obsIds)).toEqual(['crash-span', ...Array.from({ length: 30 }, (_, i) => `big-${i}`)]);
  }, 30_000);

  it('sends only the newest 16MB of a crash backlog and stays within its time bound', async () => {
    const { code, stderr, batches } = await crash('hugebacklog');
    expect(code).toBe(1);
    // The fixture stamps the moment it throws and the reporter's crash flush has its 1s cap (worker start-up included).
    const thrownAt = Number(/thrown-at=(\d+)/.exec(stderr)?.[1]);
    const exitedAt = Number(/exit-at=(\d+)/.exec(stderr)?.[1]);
    expect(exitedAt - thrownAt).toBeLessThan(1500);
    const bytes = batches.reduce((sum, batch) => sum + Buffer.byteLength(JSON.stringify({ batch })), 0);
    expect(bytes).toBeLessThanOrEqual(16 * 1024 * 1024 + 64 * 1024);
    const ids = batches.flatMap(obsIds);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.at(-1)).toBe('huge-199'); // newest first to be kept
    expect(batches.flat().map((e) => e.type)).toContain('agent.deregister');
  }, 30_000);

  it('resends the batch a POST still in flight was carrying when the process died', async () => {
    const { code, batches } = await crash('inflight', true);
    expect(code).toBe(1);
    // the POST held open carries the run's start and end; the crash resends both
    expect(batches.map(obsEvents)).toEqual([['crash-span:start', 'crash-span:end'], ['crash-span:start', 'crash-span:end']]);
  }, 30_000);

  it.each([['handled'], ['capture']] as const)('keeps reporting when the script survives the throw itself (%s)', async (mode) => {
    const { code, stderr, batches } = await crash(mode);
    expect(code).toBe(0); // the user's listener / capture callback kept the process alive; the reporter did not exit it
    expect(stderr).toContain('handled: fixture: uncaught exception after run');
    expect(batches.flatMap(obsIds)).toEqual(['crash-span', 'after-span']);
  }, 30_000);

  it('only flushes, and stays hooked, when an uncaughtException listener keeps the process alive', async () => {
    // vitest itself listens for 'uncaughtException', so this is the survivable-throw path.
    const before = process.listenerCount('uncaughtExceptionMonitor');
    const { r, posted } = reporter({ registerExitHooks: true });
    for (const id of ['one', 'two']) {
      const span = makeSpan({ id });
      r.onSpanStart(span);
      r.onSpanEnd(span);
      // Call the listeners directly: emitting the event for real would also reach vitest's own monitors.
      const monitor = process.listeners('uncaughtExceptionMonitor').at(-1);
      monitor?.(new Error('survived'), 'uncaughtException');
      await vi.waitFor(() => expect(observations(posted).map((e) => e.data.obs_id)).toContain(id));
    }
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before + 1);
    expect(allEvents(posted).map((e) => e.type)).not.toContain('agent.deregister'); // not closed
  });

  it('removes the crash hook on close()', async () => {
    const before = process.listenerCount('uncaughtExceptionMonitor');
    const { r } = reporter({ registerExitHooks: true });
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before + 1);
    await r.close();
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(before);
  });
});

describe('blockingPost', () => {
  it('delivers nothing to an unreachable collector', () => {
    expect(blockingPost('http://127.0.0.1:1/api/v1/ingest', {}, ['{}', '{}'], 1000)).toEqual([false, false]);
    expect(blockingPost('http://127.0.0.1:1/api/v1/ingest', {}, [], 1000)).toEqual([]);
  });

  it('gives up after its timeout', async () => {
    // Blocking this thread means an in-process server can never answer: the wait must end on its own.
    const server = http.createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const t0 = Date.now();
      expect(blockingPost(`http://127.0.0.1:${port}/`, {}, ['{}'], 200)).toEqual([false]);
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('env wiring', () => {
  it('returns undefined when LOUSHO_OBSERVE is unset or off', () => {
    expect(observeExporterFromEnv({ env: {} })).toBeUndefined();
    expect(observeExporterFromEnv({ env: { LOUSHO_OBSERVE: '0' } })).toBeUndefined();
    expect(observeExporterFromEnv({ env: { LOUSHO_OBSERVE: 'false' } })).toBeUndefined();
  });

  it('maps =1/true to the loopback default and passes a URL through', async () => {
    const { fetchFn, posted } = mockFetch();
    vi.stubGlobal('fetch', fetchFn);
    try {
      const a = observeExporterFromEnv({ agentName: 'env-a', env: { LOUSHO_OBSERVE: '1', LOUSHO_OBSERVE_PORT: '8877' } });
      expect(a).toBeDefined();
      await a!.close();
      expect(posted.at(-1)?.url).toBe('http://127.0.0.1:8877/api/v1/ingest');
      const b = observeExporterFromEnv({ agentName: 'env-b', env: { LOUSHO_OBSERVE: 'http://example.test:9999' } });
      await b!.close();
      expect(posted.at(-1)?.url).toBe('http://example.test:9999/api/v1/ingest');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('memoizes per (name, project, url)', () => {
    const { fetchFn } = mockFetch();
    vi.stubGlobal('fetch', fetchFn);
    try {
      const env = { LOUSHO_OBSERVE: '1' };
      expect(observeExporterFromEnv({ agentName: 'memo-a', env })).toBe(observeExporterFromEnv({ agentName: 'memo-a', env }));
      expect(observeExporterFromEnv({ agentName: 'memo-a', env })).not.toBe(observeExporterFromEnv({ agentName: 'memo-b', env }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('fanOutExporters / withObserveExporter', () => {
  const counting = (): { exporter: TraceExporter; spans: string[] } => {
    const spans: string[] = [];
    return { spans, exporter: { onSpanStart: (s) => void spans.push(`start:${s.id}`), onSpanEnd: (s) => void spans.push(`end:${s.id}`) } };
  };

  it('fans every span out to each exporter and dedupes', () => {
    const a = counting();
    const b = counting();
    const fan = fanOutExporters([a.exporter, b.exporter, a.exporter, undefined]);
    const span = makeSpan({ id: 'x' });
    fan?.onSpanStart(span);
    fan?.onSpanEnd(span);
    expect(a.spans).toEqual(['start:x', 'end:x']);
    expect(b.spans).toEqual(['start:x', 'end:x']);
    // re-composing a fan with one of its parts still delivers once each
    const fan2 = fanOutExporters([fan, a.exporter]);
    fan2?.onSpanStart(makeSpan({ id: 'y' }));
    expect(a.spans).toEqual(['start:x', 'end:x', 'start:y']);
    expect(b.spans.filter((s) => s === 'start:y')).toHaveLength(1);
  });

  it('keeps one exporter seeing spans when another throws', () => {
    const good = counting();
    const bad: TraceExporter = {
      onSpanStart: () => {
        throw new Error('boom');
      },
      onSpanEnd: () => {
        throw new Error('boom');
      },
    };
    const fan = fanOutExporters([bad, good.exporter]);
    const span = makeSpan();
    expect(() => fan?.onSpanStart(span)).toThrow('boom');
    expect(() => fan?.onSpanEnd(span)).toThrow('boom');
    expect(good.spans).toEqual([`start:${span.id}`, `end:${span.id}`]);
  });

  it('env-composes an explicit exporter once (no double env reporter)', () => {
    const env = { LOUSHO_OBSERVE: '1', LOUSHO_OBSERVE_PORT: '3' };
    const explicit = counting();
    vi.stubEnv('LOUSHO_OBSERVE', env.LOUSHO_OBSERVE);
    vi.stubEnv('LOUSHO_OBSERVE_PORT', env.LOUSHO_OBSERVE_PORT);
    try {
      const composed = withObserveExporter(explicit.exporter, 'combo-a');
      expect(composed).toBeDefined();
      // composing an already env-composed exporter returns it unchanged
      expect(withObserveExporter(composed, 'combo-a')).toBe(composed);
      const span = makeSpan({ id: 'z' });
      composed?.onSpanStart(span);
      composed?.onSpanEnd(span);
      expect(explicit.spans).toEqual(['start:z', 'end:z']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
