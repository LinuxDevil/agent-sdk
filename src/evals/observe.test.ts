/**
 * Eval score emission (observability evaluators): `scoreEventsOf` maps one
 * score row per AssertionResult (`<eval>/<assertion>`, judge vs eval source,
 * failure comment); `evalCaseObservation` runs the case inside an `eval`
 * span when LOUSHO_OBSERVE is set - the span's id is the trace_id the score
 * rows and the exercised run share - and stays a plain no-op when it is not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { IngestEvent } from '../observe/envelope';
import type { EvalResult } from './evalResult';
import { evalCaseObservation, evalObservationEnabled, scoreEventsOf, scoredAgentName } from './observe';
import { runTrajectoryCase } from './trajectory';
import { atLeast } from './checks';
import { remoteTarget } from './remoteTarget';
import { z } from 'zod';
import { defineTool } from '../tools/defineTool';

const noopFetch = () => {
  const calls: { url: string; batch: IngestEvent[] }[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), batch: (JSON.parse(String(init?.body)) as { batch: IngestEvent[] }).batch });
    return new Response('{}', { status: 202 });
  });
  return { fetchFn, calls };
};

const scoreEvents = (calls: { batch: IngestEvent[] }[]) =>
  calls.flatMap((c) => c.batch).filter((e): e is Extract<IngestEvent, { type: 'score' }> => e.type === 'score');

function result(over: Partial<EvalResult> = {}): EvalResult {
  return {
    name: 'refund eval',
    tags: [],
    passed: true,
    assertions: [
      { name: 'completed()', kind: 'gate', passed: true, score: 1, threshold: 1 },
      { name: 'tone', kind: 'soft', passed: false, score: 0.2, threshold: 0.7, message: 'soft check failed', source: 'judge' },
    ],
    durationMs: 5,
    steps: 1,
    toolCalls: [],
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('scoreEventsOf', () => {
  it('maps one score row per AssertionResult with the spec naming and source', () => {
    const events = scoreEventsOf(result(), { traceId: 'trace-1', agentId: 'agent-1', now: () => 42, newId: () => 'fresh-id' });
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      type: 'score',
      data: {
        score_id: 'fresh-id',
        trace_id: 'trace-1',
        name: 'refund eval/completed()',
        value: 1,
        source: 'eval',
        agent_id: 'agent-1',
        ts: 42,
      },
    });
    expect(events[1].type === 'score' && events[1].data).toMatchObject({
      name: 'refund eval/tone',
      value: 0.2,
      source: 'judge',
      comment: 'soft check failed',
    });
  });

  it('emits an eval-level pass/fail row after the per-assertion rows', () => {
    const base = { kind: 'gate' as const, score: 1 };
    const events = scoreEventsOf(
      result({
        assertions: [
          { ...base, name: 'completed()', passed: true },
          { ...base, name: 'mentions receipt (expected to fail)', passed: false, score: 0 },
          { ...base, name: 'no tools', passed: true },
        ],
      }),
      { traceId: 'trace-1', agentId: 'agent-1', now: () => 42, newId: () => 'fresh-id' }
    );
    expect(events).toHaveLength(4);
    expect(events[3]).toEqual({
      type: 'score',
      data: {
        score_id: 'fresh-id',
        trace_id: 'trace-1',
        name: 'refund eval',
        value: 0,
        source: 'eval',
        comment: 'mentions receipt (expected to fail)',
        agent_id: 'agent-1',
        ts: 42,
      },
    });
  });

  it('eval-level row is 1 with no comment when every assertion passed, and absent with zero assertions', () => {
    const passing = scoreEventsOf(result({ assertions: [{ name: 'a', kind: 'gate', passed: true, score: 1 }] }), { traceId: 't' });
    const last = passing[passing.length - 1] as Extract<IngestEvent, { type: 'score' }>;
    expect(last.data).toMatchObject({ name: 'refund eval', value: 1 });
    expect(last.data.comment).toBeUndefined();
    expect(scoreEventsOf(result({ assertions: [] }), { traceId: 't' })).toEqual([]);
  });

  it('omits comment and agent_id when absent', () => {
    const events = scoreEventsOf(result({ assertions: [{ name: 'a', kind: 'gate', passed: true, score: 1 }] }), { traceId: 't' });
    const data = (events[0] as Extract<IngestEvent, { type: 'score' }>).data;
    expect(data.comment).toBeUndefined();
    expect(data.agent_id).toBeUndefined();
  });
});

describe('scoredAgentName', () => {
  it('names a createAgent agent by its config name (default agent) and a config by .name', () => {
    expect(scoredAgentName(createAgent({ name: 'named-eval-agent', provider: mockModel(['x']) }))).toBe('named-eval-agent');
    expect(scoredAgentName(createAgent({ provider: mockModel(['x']) }))).toBe('agent');
    expect(scoredAgentName({ name: 'config-agent' })).toBe('config-agent');
  });

  it('is undefined for remote targets and nothing', () => {
    expect(scoredAgentName(remoteTarget({ url: 'http://x.test' })())).toBeUndefined();
    expect(scoredAgentName(undefined)).toBeUndefined();
  });
});

describe('evalCaseObservation', () => {
  it('runs the case with no span and emits nothing when LOUSHO_OBSERVE is unset', async () => {
    const { fetchFn, calls } = noopFetch();
    vi.stubEnv('LOUSHO_OBSERVE', '0');
    vi.stubGlobal('fetch', fetchFn);
    const observation = evalCaseObservation({ evalName: 'e' });
    let seen: string | undefined | 'unset' = 'unset';
    await observation.run(async (parentSpanId) => {
      seen = parentSpanId;
    });
    expect(seen).toBeUndefined();
    observation.emit(result());
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    expect(evalObservationEnabled({ LOUSHO_OBSERVE: '0' })).toBe(false);
    expect(evalObservationEnabled({ LOUSHO_OBSERVE: '1' })).toBe(true);
  });

  it('parents the exercised run under the eval span and posts the score rows with its id as trace_id', async () => {
    const { fetchFn, calls } = noopFetch();
    vi.stubEnv('LOUSHO_OBSERVE', '1');
    vi.stubEnv('LOUSHO_OBSERVE_PORT', '1');
    vi.stubGlobal('fetch', fetchFn);
    const observation = evalCaseObservation({ evalName: 'refund eval', agent: { name: 'eval-observe-scored' } });
    let spanId: string | undefined;
    await observation.run(async (parentSpanId) => {
      spanId = parentSpanId;
    });
    expect(spanId).toEqual(expect.any(String));
    await observation.emit(result());
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const scores = scoreEvents(calls);
    expect(scores).toHaveLength(3);
    for (const event of scores) {
      expect(event.data.trace_id).toBe(spanId);
      expect(event.data.agent_id).toEqual(expect.any(String));
    }
    expect(scores[0].data.name).toBe('refund eval/completed()');
  });

  it('posts the eval span before the score rows, with the same trace_id', async () => {
    const { fetchFn, calls } = noopFetch();
    vi.stubGlobal('fetch', fetchFn);
    const observation = evalCaseObservation({ evalName: 'e', agent: { name: 'eval-flush-scored' }, env: { LOUSHO_OBSERVE: 'http://x' } });
    await observation.run(async () => {});
    await observation.emit(result());
    const spanBatch = calls.findIndex((c) => c.batch.some((e) => e.type === 'observation'));
    const scoreBatch = calls.findIndex((c) => c.batch.some((e) => e.type === 'score'));
    expect(spanBatch).toBeGreaterThanOrEqual(0);
    expect(spanBatch).toBeLessThan(scoreBatch);
    const span = calls[spanBatch].batch.find((e) => e.type === 'observation' && e.data.name === 'eval e');
    expect(span).toBeDefined();
    const scores = scoreEvents(calls);
    expect(scores).toHaveLength(3);
    for (const event of scores) expect(event.data.trace_id).toBe((span as Extract<IngestEvent, { type: 'observation' }>).data.obs_id);
  });

  it('adds at most ~2.5s per case when the daemon accepts but never answers, then skips the waits', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const observation = () => evalCaseObservation({ evalName: 'e', agent: { name: 'eval-blackhole' }, env: { LOUSHO_OBSERVE: 'http://x' } });
    const first = observation();
    const started = Date.now();
    await expect(first.run(async () => 'ok')).resolves.toBe('ok');
    await first.emit(result());
    expect(Date.now() - started).toBeLessThan(2500);
    const second = observation();
    const again = Date.now();
    await second.run(async () => 'ok');
    await second.emit(result());
    expect(Date.now() - again).toBeLessThan(200);
  });

  /**
   * A daemon whose behaviour the test switches: `hang` accepts and never answers
   * (until the request's abort, like real fetch, or a restart), `refuse` fails at once.
   */
  const switchableDaemon = () => {
    const hung: Array<() => void> = [];
    const state = {
      mode: 'ok' as 'ok' | 'hang' | 'refuse',
      calls: [] as { url: string; batch: IngestEvent[] }[],
      /** The daemon restarts healthy: the connections it held open are reset. */
      restart() {
        state.mode = 'ok';
        for (const reset of hung.splice(0)) reset();
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (state.mode === 'refuse') throw new TypeError('connect ECONNREFUSED');
        if (state.mode === 'hang') {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
            hung.push(() => reject(new TypeError('socket hang up')));
          });
        }
        state.calls.push({ url: String(input), batch: (JSON.parse(String(init?.body)) as { batch: IngestEvent[] }).batch });
        return new Response('{}', { status: 202 });
      })
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    return state;
  };

  it("sends later cases' scores once a slow flush is past: the skip-the-waits latch expires", async () => {
    const daemon = switchableDaemon();
    let clock = 1_000_000;
    const observation = () =>
      evalCaseObservation({ evalName: 'e', agent: { name: 'eval-slow-then-healthy' }, env: { LOUSHO_OBSERVE: 'http://x' }, now: () => clock });
    daemon.mode = 'hang';
    const first = observation();
    await first.run(async () => 'ok');
    await first.emit(result());
    daemon.restart();
    clock += 31_000;
    const second = observation();
    await second.run(async () => 'ok');
    await second.emit(result());
    const scores = scoreEvents(daemon.calls);
    expect(scores).toHaveLength(6); // the slow case's scores were queued, not lost
    expect(new Set(scores.map((e) => e.data.trace_id)).size).toBe(2);
  });

  it('sends the scores of a case run during a daemon outage once the daemon is back', async () => {
    const daemon = switchableDaemon();
    const observation = () => evalCaseObservation({ evalName: 'e', agent: { name: 'eval-outage' }, env: { LOUSHO_OBSERVE: 'http://x' } });
    daemon.mode = 'refuse';
    const first = observation();
    await first.run(async () => 'ok');
    await first.emit(result());
    expect(daemon.calls).toHaveLength(0);
    daemon.mode = 'ok';
    const second = observation();
    await second.run(async () => 'ok');
    await second.emit(result());
    const events = daemon.calls.flatMap((c) => c.batch);
    expect(scoreEvents(daemon.calls)).toHaveLength(6);
    // Each case's eval span lands before its own scores.
    const spanAt = (name: string) => events.findIndex((e) => e.type === 'observation' && e.data.name === name && e.data.end !== undefined);
    const firstScoreAt = events.findIndex((e) => e.type === 'score');
    expect(spanAt('eval e')).toBeGreaterThanOrEqual(0);
    expect(spanAt('eval e')).toBeLessThan(firstScoreAt);
  });

  it('lets the case pass and resolves emit when every request is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const observation = evalCaseObservation({ evalName: 'e', agent: { name: 'eval-refused' }, env: { LOUSHO_OBSERVE: 'http://x' } });
    await expect(observation.run(async () => 'ok')).resolves.toBe('ok');
    await expect(observation.emit(result())).resolves.toBeUndefined();
  });
});

describe('runTrajectoryCase emission (integration)', () => {
  const lookup = defineTool({
    name: 'lookup_order',
    description: 'Look up an order',
    input: z.object({ orderId: z.string() }),
    execute: ({ orderId }) => ({ orderId }),
  });

  it('emits score rows bound to the exercised run trace, judge verdicts as source judge', async () => {
    const { fetchFn, calls } = noopFetch();
    vi.stubEnv('LOUSHO_OBSERVE', '1');
    vi.stubEnv('LOUSHO_OBSERVE_PORT', '1');
    vi.stubGlobal('fetch', fetchFn);
    const agent = createAgent({ name: 'eval-scored-agent', prompt: 'p', provider: mockModel(['done.']), tools: [lookup] });
    const judge = { provider: mockModel(['SCORE: 0.9']) };
    const res = await runTrajectoryCase(
      {
        name: 'scored eval',
        agent,
        judge,
        test: async (t) => {
          await t.send('hi');
          t.completed();
          t.soft('tone', await t.judge('be nice'), atLeast(0.7));
        },
      },
      {},
      'case a',
      undefined
    );
    expect(res.passed).toBe(true);
    expect(res.assertions.find((a) => a.name === 'tone')?.source).toBe('judge');
    await vi.waitFor(() => expect(scoreEvents(calls)).toHaveLength(3));
    const scores = scoreEvents(calls);
    const traceIds = new Set(scores.map((e) => e.data.trace_id));
    expect(traceIds.size).toBe(1);
    expect(scores.map((e) => e.data.name).sort()).toEqual(['scored eval', 'scored eval/completed()', 'scored eval/tone']);
    expect(scores.find((e) => e.data.name === 'scored eval/tone')?.data.source).toBe('judge');
    expect(scores.find((e) => e.data.name === 'scored eval/completed()')?.data.source).toBe('eval');
    expect(scores.every((e) => typeof e.data.agent_id === 'string' && e.data.agent_id.length > 0)).toBe(true);
  });

  it('emits nothing when LOUSHO_OBSERVE is off, and the case still runs', async () => {
    const { fetchFn, calls } = noopFetch();
    vi.stubEnv('LOUSHO_OBSERVE', '0');
    vi.stubGlobal('fetch', fetchFn);
    const res = await runTrajectoryCase(
      {
        name: 'quiet eval',
        agent: createAgent({ provider: mockModel(['hi.']) }),
        test: async (t) => {
          await t.send('hi');
          t.completed();
        },
      },
      {},
      undefined,
      undefined
    );
    expect(res.passed).toBe(true);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });
});
