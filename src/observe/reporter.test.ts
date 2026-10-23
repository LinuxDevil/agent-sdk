/**
 * The reporter's contract: finished spans become `observation` events
 * (span.id is obs_id, parentage gives the trace), flushes are size/interval/
 * exit-triggered and serialized, an unreachable daemon or a full buffer
 * drops-and-counts without ever throwing into the run, and the env
 * (`LOUSHO_OBSERVE`) wiring composes with an explicit exporter.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenAiAttr, GenAiOperation, LegacyAttr, SdkAttr } from '../execution/semconv';
import type { Span, TraceExporter } from '../execution/tracing';
import type { IngestEvent } from './envelope';
import { fanOutExporters, observeExporter, observeExporterFromEnv, withObserveExporter, type ObserveReporter } from './reporter';

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

    const obs = observations(posted);
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

    const d = observations(posted)[0].data;
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
    const d = observations(posted)[0].data;
    expect(d.model).toBe('old-m');
    expect(d.usage_input_tokens).toBe(9);
    expect(d.input).toBe('hi');
    expect(d.output).toBe('yo');
  });

  it('flushes when the buffer reaches flushSize', async () => {
    const { r, posted } = reporter({ flushSize: 3 });
    for (let i = 0; i < 3; i++) {
      const span = makeSpan({ id: `s${i}` });
      r.onSpanStart(span);
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
        r.onSpanStart(span);
        r.onSpanEnd(span);
      }
      expect(r.dropped).toBe(3);
      await r.close();
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

  it('counts a span ending after close() as dropped', async () => {
    const { r } = reporter();
    await r.close();
    const span = makeSpan();
    r.onSpanStart(span);
    r.onSpanEnd(span);
    expect(r.dropped).toBe(1);
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
