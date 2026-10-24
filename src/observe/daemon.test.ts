/**
 * End-to-end daemon tests over real HTTP on an ephemeral port: the health
 * marker, ingest 202 + truncation + 413, the traces/insights/agents/status
 * read endpoints, bearer auth when required, and the "already running"
 * port-collision detection.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as nodePath from 'node:path';
import { defaultPidPath, isObserveDaemon, probeHealth, sameDbPath, startObserveDaemon, type ObserveDaemon } from './daemon';
import { OBSERVE_SERVICE } from './envelope';
import { createToken, openDb } from './store';

const T0 = 1_700_000_000_000;

const daemons: ObserveDaemon[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.close();
});

async function start(opts: Parameters<typeof startObserveDaemon>[0] = {}): Promise<ObserveDaemon> {
  const daemon = await startObserveDaemon({ dbPath: ':memory:', port: 0, ...opts });
  daemons.push(daemon);
  return daemon;
}

const url = (daemon: ObserveDaemon, path: string): string => `http://127.0.0.1:${daemon.port}${path}`;

const obs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  obs_id: 'o1',
  trace_id: 't1',
  session_id: 's1',
  agent_id: 'a1',
  kind: 'span',
  name: 'invoke_agent a',
  start: T0,
  end: T0 + 100,
  status: 'ok',
  ...over,
});

const post = (daemon: ObserveDaemon, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url(daemon, '/api/v1/ingest'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('GET /health', () => {
  it('returns the lousho-observe service marker', async () => {
    const daemon = await start();
    const res = await fetch(url(daemon, '/health'));
    const body = (await res.json()) as { service: string; ok: boolean; version: string };
    expect(res.status).toBe(200);
    expect(body.service).toBe(OBSERVE_SERVICE);
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(isObserveDaemon(await probeHealth(daemon.port))).toBe(true);
  });
});

describe('per-db pidfile and db identity', () => {
  it('names the pidfile after the db so two dbs in one folder never share it', () => {
    expect(defaultPidPath('/d/a.db')).toBe(nodePath.resolve('/d/a.pid'));
    expect(defaultPidPath('/d/b.db')).toBe(nodePath.resolve('/d/b.pid'));
    expect(defaultPidPath('/d/observe.db')).toBe(nodePath.resolve('/d/observe.pid'));
    expect(defaultPidPath('/d/data.sqlite')).toBe(nodePath.resolve('/d/data.sqlite.pid'));
  });

  it('/health reports the absolute db path; sameDbPath compares resolved paths', async () => {
    const daemon = await start({ dbPath: 'mem-test.db', db: openDb(':memory:') });
    const health = await probeHealth(daemon.port);
    expect(health?.db).toBe(nodePath.resolve('mem-test.db'));
    expect(sameDbPath(health?.db, 'mem-test.db')).toBe(true);
    expect(sameDbPath(health?.db, 'other.db')).toBe(false);
    expect(sameDbPath(undefined, 'other.db')).toBe(false);
  });
});

describe('POST /api/v1/ingest', () => {
  it('accepts a batch and serves it back through the read endpoints', async () => {
    const daemon = await start();
    const res = await post(daemon, {
      batch: [
        { type: 'agent.heartbeat', data: { agent_id: 'a1', project: 'p', name: 'a' } },
        { type: 'observation', data: obs() },
        { type: 'observation', data: obs({ obs_id: 'o2', parent_obs_id: 'o1', kind: 'tool', name: 'call_tool x' }) },
        { type: 'score', data: { score_id: 's1', trace_id: 't1', name: 'eval/acc', value: 0.9, source: 'judge' } },
      ],
    });
    expect(res.status).toBe(202);

    const list = (await (await fetch(url(daemon, '/api/v1/traces'))).json()) as { traces: { trace_id: string }[]; total: number };
    expect(list.total).toBe(1);
    expect(list.traces[0].trace_id).toBe('t1');

    const detail = (await (await fetch(url(daemon, '/api/v1/traces/t1'))).json()) as {
      observations: { obs_id: string; parent_obs_id: string | null }[];
      scores: { name: string }[];
    };
    // flat rows; the panel nests by parent_obs_id
    expect(detail.observations[0].obs_id).toBe('o1');
    expect(detail.observations[1].obs_id).toBe('o2');
    expect(detail.observations[1].parent_obs_id).toBe('o1');
    expect(detail.scores[0].name).toBe('eval/acc');

    const scores = (await (await fetch(url(daemon, '/api/v1/scores'))).json()) as { scores: { name: string; value: number }[] };
    expect(scores.scores[0].name).toBe('eval/acc');
    expect(scores.scores[0].value).toBe(0.9);

    const agents = (await (await fetch(url(daemon, '/api/v1/agents'))).json()) as { agents: { agent_id: string }[] };
    expect(agents.agents[0].agent_id).toBe('a1');
  });

  it('rejects a malformed envelope with 400', async () => {
    const daemon = await start();
    const res = await post(daemon, { batch: [{ type: 'nope', data: {} }] });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'LOUSHO_REQUEST_INVALID' });
  });

  it('rejects a body over the size cap with 413', async () => {
    const daemon = await start();
    const res = await post(daemon, {
      batch: [{ type: 'observation', data: obs({ input: 'x'.repeat(6 * 1024 * 1024) }) }],
    });
    expect(res.status).toBe(413);
  });

  it('truncates a field over 64KB and flags the stored row', async () => {
    const daemon = await start();
    const big = 'y'.repeat(70 * 1024);
    await post(daemon, { batch: [{ type: 'observation', data: obs({ output: big }) }] });
    const detail = (await (await fetch(url(daemon, '/api/v1/traces/t1'))).json()) as {
      observations: { output?: string; truncated: boolean }[];
    };
    expect(detail.observations[0].output?.length).toBe(64 * 1024);
    expect(detail.observations[0].truncated).toBe(true);
  });
});

describe('status + insights', () => {
  it('reports counts through /api/v1/status and aggregates through /api/v1/insights', async () => {
    const daemon = await start();
    await post(daemon, {
      batch: [
        { type: 'agent.heartbeat', data: { agent_id: 'a1', project: 'p' } },
        { type: 'observation', data: obs({ cost_usd: 0.01, usage_input_tokens: 10, usage_output_tokens: 5 }) },
      ],
    });
    const status = (await (await fetch(url(daemon, '/api/v1/status'))).json()) as {
      service: string;
      counts: { agents: number; observations: number; traces: number };
    };
    expect(status.service).toBe(OBSERVE_SERVICE);
    expect(status.counts).toMatchObject({ agents: 1, observations: 1, traces: 1 });

    // the default window is "last 7 days" and the fixture timestamps are fixed - bound it explicitly
    // (bucket_start must fall inside [since, until), so reach back a full bucket)
    const insights = (await (
      await fetch(url(daemon, `/api/v1/insights?granularity=hour&since=${T0 - 3_600_000}&until=${T0 + 86_400_000}`))
    ).json()) as {
      agents: { agent_id: string }[];
      series: { metric: string; value: number }[];
    };
    expect(insights.agents[0]?.agent_id).toBe('a1');
    const runs = insights.series.find((r) => r.metric === 'runs');
    expect(runs?.value).toBe(1);
  });
});

describe('token auth', () => {
  it('rejects /api/v1/* without a bearer token when requireToken is set, but /health stays open', async () => {
    const daemon = await start({ requireToken: true });
    expect((await fetch(url(daemon, '/api/v1/traces'))).status).toBe(401);
    expect((await fetch(url(daemon, '/api/v1/ingest'), { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(url(daemon, '/health'))).status).toBe(200);

    const { key } = createToken(daemon.db, 'proj');
    const authed = await fetch(url(daemon, '/api/v1/traces'), { headers: { authorization: `Bearer ${key}` } });
    expect(authed.status).toBe(200);
  });
});

describe('port collision', () => {
  it('a second daemon on the same port fails with EADDRINUSE; the health probe identifies ours', async () => {
    const daemon = await start();
    await expect(startObserveDaemon({ dbPath: ':memory:', port: daemon.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // the probe distinguishes our daemon from a random listener
    expect(isObserveDaemon(await probeHealth(daemon.port))).toBe(true);
  });
});
