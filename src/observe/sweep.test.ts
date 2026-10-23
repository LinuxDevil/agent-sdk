/**
 * The monitoring child's contract: the sweep's freshness transitions
 * (healthy -> stale -> down), the crash path flipping a dead agent's open
 * sessions/unfinished observations to 'interrupted', webhook alerts on the
 * transition and on error-rate crossings, `alerts.json` config resolution,
 * and the enriched `GET /api/v1/agents` fields.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { loadAlertsFile, resolveAlertConfig, createAlerter, type AlertEvent } from './alerts';
import { startObserveDaemon, type ObserveDaemon } from './daemon';
import type { IngestEvent } from './envelope';
import { ingestBatch, listAgents, openDb } from './store';
import { startStatusSweep, sweepAgents } from './sweep';

const T0 = 1_700_000_000_000;

const dbs: SqlDatabase[] = [];
const daemons: ObserveDaemon[] = [];
const sweeps: Array<{ stop(): void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (sweeps.length > 0) sweeps.pop()?.stop();
  while (daemons.length > 0) await daemons.pop()?.close();
  while (dbs.length > 0) dbs.pop()?.close();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function db(): SqlDatabase {
  const database = openDb(':memory:');
  dbs.push(database);
  return database;
}

const heartbeat = (agentId: string, ts: number, intervalMs = 60_000): IngestEvent => ({
  type: 'agent.heartbeat',
  data: { agent_id: agentId, project: 'proj', name: 'a', ts, heartbeat_interval_ms: intervalMs },
});

const obs = (over: Record<string, unknown> = {}): IngestEvent => ({
  type: 'observation',
  data: {
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
  },
});

describe('sweepAgents transitions', () => {
  it('ages an agent healthy -> stale -> down and persists each transition once', () => {
    const database = db();
    ingestBatch(database, [heartbeat('a1', T0)], T0);

    // 60s interval: healthy within 2 intervals + 10s slack (130s)
    let result = sweepAgents(database, T0 + 60_000);
    expect(result.transitions).toHaveLength(0);
    expect(listAgents(database, T0 + 60_000)[0].status).toBe('healthy');

    result = sweepAgents(database, T0 + 140_000);
    expect(result.transitions).toEqual([expect.objectContaining({ agent_id: 'a1', from: 'healthy', to: 'stale', crashed: false })]);
    expect(result.alerts).toHaveLength(0); // stale does not alert
    expect(listAgents(database, T0 + 140_000)[0].status).toBe('stale');

    // a quiet pass rewrites nothing
    expect(sweepAgents(database, T0 + 200_000).transitions).toHaveLength(0);

    result = sweepAgents(database, T0 + 310_000);
    expect(result.transitions).toEqual([expect.objectContaining({ agent_id: 'a1', from: 'stale', to: 'down', crashed: true })]);
    expect(listAgents(database, T0 + 310_000)[0].status).toBe('down');
    expect(result.alerts).toEqual([
      expect.objectContaining({ type: 'agent.status', agent_id: 'a1', project: 'proj', status: 'down' }),
    ]);
    // staying down alerts once - the transition already happened
    expect(sweepAgents(database, T0 + 400_000).alerts).toHaveLength(0);
  });

  it('honors the reporter-declared heartbeat interval', () => {
    const database = db();
    ingestBatch(database, [heartbeat('a1', T0, 10_000)], T0);
    expect(sweepAgents(database, T0 + 26_000).transitions).toHaveLength(0); // within 2*10s+10s
    expect(sweepAgents(database, T0 + 31_000).transitions[0]?.to).toBe('stale');
    expect(sweepAgents(database, T0 + 51_000).transitions[0]?.to).toBe('down'); // past 5*10s
  });

  it('never ages a deregistered (stopped) agent into down', () => {
    const database = db();
    ingestBatch(database, [heartbeat('a1', T0), { type: 'agent.deregister', data: { agent_id: 'a1', ts: T0 + 5_000 } }], T0);
    const result = sweepAgents(database, T0 + 9_000_000);
    expect(result.transitions).toHaveLength(0);
    expect(result.alerts).toHaveLength(0);
    expect(listAgents(database, T0 + 9_000_000)[0].status).toBe('stopped');
  });
});

describe('crash handling', () => {
  it("flips a crashed agent's open sessions and unfinished observations to 'interrupted'", () => {
    const database = db();
    ingestBatch(
      database,
      [
        heartbeat('a1', T0),
        // an unfinished span (no end) - the run died mid-flight
        obs({ obs_id: 'o-open', trace_id: 't-open', session_id: 's-open', end: undefined }),
        // a finished one in the same agent: untouched
        obs({ obs_id: 'o-done', trace_id: 't-done', session_id: 's-done' }),
      ],
      T0
    );
    // stale is not a crash yet
    sweepAgents(database, T0 + 140_000);
    expect(database.prepare('SELECT status FROM sessions WHERE session_id = ?').get('s-open')?.status).toBe('active');

    const result = sweepAgents(database, T0 + 400_000);
    expect(result.transitions[0]).toMatchObject({ to: 'down', crashed: true });

    const session = database.prepare('SELECT status, ended_at FROM sessions WHERE session_id = ?').get('s-open');
    expect(session?.status).toBe('interrupted');
    expect(Number(session?.ended_at)).toBe(T0 + 400_000);
    // every 'active' session of the dead agent flips (s-done was still 'active' too)
    expect(database.prepare('SELECT status FROM sessions WHERE session_id = ?').get('s-done')?.status).toBe('interrupted');
    const open = database.prepare('SELECT status, "end" FROM observations WHERE obs_id = ?').get('o-open');
    expect(open?.status).toBe('interrupted');
    expect(open?.end).toBeNull(); // it never finished
    expect(database.prepare('SELECT status FROM observations WHERE obs_id = ?').get('o-done')?.status).toBe('ok');

    expect(result.alerts[0]).toMatchObject({
      type: 'agent.status',
      agent_id: 'a1',
      details: { from: 'stale', interrupted_sessions: 2, interrupted_observations: 1 },
    });
  });
});

describe('error-rate alerts', () => {
  it('fires once per agent per day when the rate crosses the threshold', () => {
    const database = db();
    const now = Date.now();
    ingestBatch(
      database,
      [
        heartbeat('a1', now),
        obs({ start: now, end: now + 100 }),
        obs({ obs_id: 'o2', trace_id: 't2', start: now, end: now + 100, status: 'error' }),
      ],
      now
    );
    const state = new Map<string, number>();
    const opts = { errorRateThreshold: 0.4, errorRateState: state };
    const first = sweepAgents(database, now, opts);
    expect(first.alerts.filter((a) => a.type === 'agent.error_rate')).toEqual([
      expect.objectContaining({
        agent_id: 'a1',
        project: 'proj',
        status: 'healthy',
        details: expect.objectContaining({ error_rate: 0.5, threshold: 0.4, runs: 2, errors: 1 }),
      }),
    ]);
    // same day, still over the line: no repeat
    expect(sweepAgents(database, now + 1_000, opts).alerts).toHaveLength(0);
  });

  it('stays quiet under the threshold and ignores error-free days', () => {
    const database = db();
    const now = Date.now();
    ingestBatch(database, [heartbeat('a1', now), obs({ start: now, end: now + 100 })], now);
    const result = sweepAgents(database, now, { errorRateThreshold: 0.4, errorRateState: new Map() });
    expect(result.alerts).toHaveLength(0);
  });
});

describe('startStatusSweep', () => {
  it('runs on the injected clock and forwards alerts to onAlerts', () => {
    const database = db();
    ingestBatch(database, [heartbeat('a1', T0)], T0);
    let current = T0;
    const seen: AlertEvent[] = [];
    const sweep = startStatusSweep(database, { intervalMs: 0, now: () => current, onAlerts: (alerts) => seen.push(...alerts) });
    sweeps.push(sweep);
    expect(seen).toHaveLength(0); // boot pass: agent is fresh
    current = T0 + 400_000;
    const result = sweep.run();
    expect(result.transitions[0]?.to).toBe('down');
    expect(seen).toEqual([expect.objectContaining({ type: 'agent.status', agent_id: 'a1', status: 'down' })]);
  });
});

describe('alerts config', () => {
  it('merges alerts.json webhooks with flag webhooks and validates the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-alerts-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'alerts.json'), JSON.stringify({ webhooks: ['http://a/hook', 'http://b/hook'], errorRateThreshold: 0.3 }));
    const config = resolveAlertConfig(path.join(dir, 'observe.db'), ['http://b/hook', 'http://c/hook']);
    expect(config.webhooks).toEqual(['http://a/hook', 'http://b/hook', 'http://c/hook']);
    expect(config.errorRateThreshold).toBe(0.3);
  });

  it('missing alerts.json means no config; malformed JSON is a config error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-alerts-'));
    tempDirs.push(dir);
    expect(resolveAlertConfig(path.join(dir, 'observe.db'))).toEqual({ webhooks: [] });
    expect(resolveAlertConfig(':memory:', ['http://x'])).toEqual({ webhooks: ['http://x'] });
    fs.writeFileSync(path.join(dir, 'alerts.json'), 'not json{');
    expect(() => loadAlertsFile(path.join(dir, 'alerts.json'))).toThrowError(/not valid JSON/);
    fs.writeFileSync(path.join(dir, 'alerts.json'), JSON.stringify({ errorRateThreshold: 4 }));
    expect(() => loadAlertsFile(path.join(dir, 'alerts.json'))).toThrowError(/errorRateThreshold/);
  });
});

describe('webhook delivery', () => {
  it('POSTs the alert JSON to each webhook and warns once on failure', async () => {
    const posts: { url: string; body: AlertEvent }[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body)) as AlertEvent });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const alert: AlertEvent = {
      type: 'agent.status',
      agent_id: 'a1',
      project: 'proj',
      status: 'down',
      at: T0,
      details: { from: 'healthy' },
    };
    createAlerter({ webhooks: ['http://hook1', 'http://hook2'] }, fetchFn).post([alert]);
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.url)).toEqual(['http://hook1', 'http://hook2']);
    expect(posts[0].body).toEqual(alert);

    // a dead webhook warns exactly once across passes, and never throws
    const warn = vi.fn();
    const failing = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))) as unknown as typeof fetch;
    const alerter = createAlerter({ webhooks: ['http://dead'] }, failing, warn);
    alerter.post([alert]);
    alerter.post([alert]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('http://dead');
  });
});

/* ------------------------------------------------- daemon + http surface */

async function start(opts: Parameters<typeof startObserveDaemon>[0] = {}): Promise<ObserveDaemon> {
  const daemon = await startObserveDaemon({ dbPath: ':memory:', port: 0, ...opts });
  daemons.push(daemon);
  return daemon;
}

const post = (daemon: ObserveDaemon, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${daemon.port}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('daemon sweep + GET /api/v1/agents', () => {
  it('posts the alert payload to the configured webhook when an agent goes down', async () => {
    const posts: { url: string; body: AlertEvent }[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body)) as AlertEvent });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const daemon = await start({ webhooks: ['https://hooks.example/alerts'], fetchFn, sweepIntervalMs: 0 });
    expect(daemon.alerts.webhooks).toEqual(['https://hooks.example/alerts']);

    const old = Date.now() - 400_000;
    await post(daemon, {
      batch: [
        { type: 'agent.heartbeat', data: { agent_id: 'a1', project: 'fleet', name: 'bot', ts: old, heartbeat_interval_ms: 60_000 } },
        { type: 'observation', data: { obs_id: 'open1', trace_id: 't9', session_id: 's9', agent_id: 'a1', kind: 'span', start: old } },
      ],
    });
    const result = daemon.sweep.run();
    expect(result.transitions[0]).toMatchObject({ agent_id: 'a1', from: 'healthy', to: 'down', crashed: true });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://hooks.example/alerts');
    expect(posts[0].body).toMatchObject({
      type: 'agent.status',
      agent_id: 'a1',
      project: 'fleet',
      status: 'down',
      details: { from: 'healthy', name: 'bot', interrupted_sessions: 1, interrupted_observations: 1 },
    });
    expect(daemon.db.prepare("SELECT status FROM sessions WHERE session_id = 's9'").get()?.status).toBe('interrupted');
  });

  it('serves sweep-derived status plus runs_today / error_rate_today', async () => {
    const daemon = await start({ sweepIntervalMs: 0 });
    const now = Date.now();
    await post(daemon, {
      batch: [
        { type: 'agent.heartbeat', data: { agent_id: 'a1', project: 'fleet', name: 'bot', ts: now, heartbeat_interval_ms: 60_000 } },
        { type: 'agent.heartbeat', data: { agent_id: 'a2', project: 'other', ts: now - 400_000 } },
        { type: 'observation', data: { obs_id: 'o1', trace_id: 't1', agent_id: 'a1', kind: 'span', start: now, end: now + 100, status: 'ok' } },
        { type: 'observation', data: { obs_id: 'o2', trace_id: 't2', agent_id: 'a1', kind: 'span', start: now, end: now + 100, status: 'error' } },
      ],
    });
    const body = (await (await fetch(`http://127.0.0.1:${daemon.port}/api/v1/agents`)).json()) as {
      agents: { agent_id: string; status: string; runs_today: number; error_rate_today: number }[];
    };
    const a1 = body.agents.find((a) => a.agent_id === 'a1');
    const a2 = body.agents.find((a) => a.agent_id === 'a2');
    expect(a1).toMatchObject({ status: 'healthy', runs_today: 2, error_rate_today: 0.5 });
    expect(a2).toMatchObject({ status: 'down', runs_today: 0, error_rate_today: 0 });

    const fleet = (await (await fetch(`http://127.0.0.1:${daemon.port}/api/v1/agents?project=fleet`)).json()) as {
      agents: { agent_id: string }[];
    };
    expect(fleet.agents.map((a) => a.agent_id)).toEqual(['a1']);
  });
});
