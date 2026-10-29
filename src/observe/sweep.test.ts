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
import { ingestBatch, listAgents, openDb, pruneBefore } from './store';
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

describe('retention: pruneBefore', () => {
  const DAY = 86_400_000;
  const OLD = T0 - 10 * DAY;
  const count = (database: SqlDatabase, sql: string): number =>
    Number(database.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get()?.n ?? 0);

  function seed(database: SqlDatabase): void {
    ingestBatch(
      database,
      [
        // an old, finished trace (root + child) with a prompt link and a score
        obs({ obs_id: 'old-root', trace_id: 't-old', session_id: 's-old', start: OLD, end: OLD + 100 }),
        obs({ obs_id: 'old-child', trace_id: 't-old', session_id: 's-old', parent_obs_id: 'old-root', start: OLD + 10, end: OLD + 50 }),
        { type: 'prompt_use', data: { obs_id: 'old-root', prompt_id: 'p1', version: 1 } },
        { type: 'score', data: { score_id: 'sc-old', trace_id: 't-old', name: 'q', value: 1, source: 'eval', ts: OLD } },
        // an old trace whose child is still open: kept whole
        obs({ obs_id: 'mixed-root', trace_id: 't-mixed', session_id: 's-mixed', start: OLD, end: OLD + 100 }),
        obs({ obs_id: 'mixed-child', trace_id: 't-mixed', session_id: 's-mixed', parent_obs_id: 'mixed-root', start: OLD + 10, end: undefined }),
        // the reverse: an old open root whose children all finished long ago - kept whole
        obs({ obs_id: 'rev-root', trace_id: 't-rev', session_id: 's-rev', start: OLD, end: undefined }),
        obs({ obs_id: 'rev-child', trace_id: 't-rev', session_id: 's-rev', parent_obs_id: 'rev-root', start: OLD + 10, end: OLD + 20 }),
        // an old open root on its own
        obs({ obs_id: 'open-root', trace_id: 't-open', session_id: 's-active', start: OLD, end: undefined }),
        // a fresh trace
        obs({ obs_id: 'new-root', trace_id: 't-new', session_id: 's-new', start: T0 + 1000, end: T0 + 2000 }),
        // old / fresh scores for traces whose observations never arrived
        { type: 'score', data: { score_id: 'sc-orphan', trace_id: 't-gone', name: 'q', value: 0, source: 'eval', ts: OLD } },
        { type: 'score', data: { score_id: 'sc-orphan-new', trace_id: 't-gone2', name: 'q', value: 0, source: 'eval', ts: T0 + 1 } },
      ],
      OLD
    );
    // s-old / s-mixed were interrupted long ago; s-active is an old but still active thread
    database.prepare("UPDATE sessions SET status = 'interrupted' WHERE session_id IN ('s-old', 's-mixed')").run();
    // an old, ended, still-'active' session no observation references: only the status guard keeps it
    database
      .prepare("INSERT INTO sessions (session_id, agent_id, started_at, ended_at, status, updated_at) VALUES ('s-lonely', 'a1', ?, ?, 'active', ?)")
      .run(OLD, OLD + 5, OLD);
    database.prepare("INSERT INTO prompts (prompt_id, name, version, created_at) VALUES ('p1', 'greet', 1, ?)").run(OLD);
    database.prepare(`INSERT INTO hub_entries (entry_id, namespace, "key", value, created_at) VALUES ('h1', 'ns', 'k', 'v', ?)`).run(OLD);
  }

  it('deletes whole finished traces older than the cutoff and returns the counts', () => {
    const database = db();
    seed(database);
    const rollupsBefore = count(database, 'rollups');
    expect(rollupsBefore).toBeGreaterThan(0);

    expect(pruneBefore(database, T0)).toEqual({ observations: 2, scores: 2, sessions: 1 });

    expect(count(database, "observations WHERE trace_id = 't-old'")).toBe(0);
    expect(count(database, "prompt_uses WHERE obs_id = 'old-root'")).toBe(0);
    expect(count(database, "scores WHERE score_id IN ('sc-old', 'sc-orphan')")).toBe(0);
    expect(count(database, "scores WHERE score_id = 'sc-orphan-new'")).toBe(1);
    expect(count(database, "sessions WHERE session_id = 's-old'")).toBe(0);
    expect(count(database, "sessions WHERE session_id = 's-lonely'")).toBe(1);
    expect(count(database, "observations WHERE trace_id = 't-new'")).toBe(1);
    // rollups for the pruned days, prompt versions and hub entries are never touched
    expect(count(database, 'rollups')).toBe(rollupsBefore);
    expect(count(database, 'prompts')).toBe(1);
    expect(count(database, 'hub_entries')).toBe(1);
  });

  it('keeps open observations, a trace with one open child, and active sessions regardless of age', () => {
    const database = db();
    seed(database);
    // t-old + t-new; sc-old + both orphans; s-old (s-new is still 'active')
    expect(pruneBefore(database, T0 + 100 * DAY)).toEqual({ observations: 3, scores: 3, sessions: 1 });
    expect(count(database, "observations WHERE obs_id = 'open-root'")).toBe(1);
    // not partially deleted: the closed root stays beside its open child, and closed children beside an open root
    expect(count(database, "observations WHERE trace_id = 't-mixed'")).toBe(2);
    expect(count(database, "observations WHERE trace_id = 't-rev'")).toBe(2);
    // the status guard alone keeps an unreferenced old active session
    expect(count(database, "sessions WHERE session_id = 's-lonely'")).toBe(1);
    expect(count(database, "sessions WHERE session_id = 's-new'")).toBe(1);
    // s-mixed is interrupted and old, but its observations still reference it
    expect(count(database, "sessions WHERE session_id = 's-mixed'")).toBe(1);
    expect(count(database, "sessions WHERE session_id = 's-active'")).toBe(1);
    // the fresh trace is past this cutoff too and goes
    expect(count(database, "observations WHERE trace_id = 't-new'")).toBe(0);
  });

  it('is a no-op on a second pass', () => {
    const database = db();
    seed(database);
    pruneBefore(database, T0);
    expect(pruneBefore(database, T0)).toEqual({ observations: 0, scores: 0, sessions: 0 });
  });
});

describe('retention: interrupted traces', () => {
  const DAY = 86_400_000;
  const OLD = T0 - 10 * DAY;
  const SWEPT = OLD + 400_000; // when the sweep interrupts a1's open runs
  const count = (database: SqlDatabase, sql: string): number =>
    Number(database.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get()?.n ?? 0);
  const open = { end: undefined, status: undefined };

  /** a1 opens runs and then goes quiet; a2 keeps heartbeating, so only a1's runs are interrupted by the real sweep. */
  function seed(database: SqlDatabase): void {
    ingestBatch(
      database,
      [
        heartbeat('a1', OLD),
        obs({ obs_id: 'int-root', trace_id: 't-int', session_id: 's-int', start: OLD, ...open }),
        obs({ obs_id: 'int-child', trace_id: 't-int', session_id: 's-int', parent_obs_id: 'int-root', start: OLD + 5, ...open }),
        // interrupted run beside a child that ended after the cutoff
        obs({ obs_id: 'late-root', trace_id: 't-late', session_id: 's-late', start: OLD, ...open }),
        obs({ obs_id: 'late-child', trace_id: 't-late', session_id: 's-late', parent_obs_id: 'late-root', start: OLD + 5, end: T0 + 5000 }),
      ],
      OLD
    );
    ingestBatch(
      database,
      [heartbeat('a2', SWEPT), obs({ obs_id: 'live-root', trace_id: 't-live', session_id: 's-live', agent_id: 'a2', start: OLD, ...open })],
      SWEPT
    );
    sweepAgents(database, SWEPT);
  }

  it('prunes an interrupted trace (end NULL) whose interrupt predates the cutoff, and its interrupted session', () => {
    const database = db();
    seed(database);
    expect(database.prepare("SELECT status FROM observations WHERE obs_id = 'int-root'").get()?.status).toBe('interrupted');
    expect(database.prepare("SELECT status FROM sessions WHERE session_id = 's-int'").get()?.status).toBe('interrupted');

    expect(pruneBefore(database, T0).observations).toBe(2);

    expect(count(database, "observations WHERE trace_id = 't-int'")).toBe(0);
    expect(count(database, "sessions WHERE session_id = 's-int'")).toBe(0);
    // an open run (status NULL) of a live agent is kept
    expect(count(database, "observations WHERE trace_id = 't-live'")).toBe(1);
    // an interrupted run beside a child that ended after the cutoff is kept whole
    expect(count(database, "observations WHERE trace_id = 't-late'")).toBe(2);
  });

  it('keeps an interrupted trace whose interrupt is not older than the cutoff', () => {
    const database = db();
    seed(database);
    // OLD < cutoff <= SWEPT: the runs started before the cutoff but were interrupted at SWEPT
    expect(pruneBefore(database, SWEPT)).toEqual({ observations: 0, scores: 0, sessions: 0 });
    expect(count(database, "observations WHERE trace_id = 't-int'")).toBe(2);
  });
});

describe('retention: the sweep prune pass', () => {
  const DAY = 86_400_000;
  const traceCount = (database: SqlDatabase, traceId: string): number =>
    Number(database.prepare('SELECT COUNT(*) AS n FROM observations WHERE trace_id = ?').get(traceId)?.n ?? 0);

  it('prunes on the first pass and then at most once per 24h', () => {
    const database = db();
    ingestBatch(database, [obs({ obs_id: 'a', trace_id: 'ta', start: T0 - 40 * DAY, end: T0 - 40 * DAY + 1 })], T0);
    let current = T0;
    const sweep = startStatusSweep(database, { intervalMs: 0, now: () => current, retentionDays: 30 });
    sweeps.push(sweep);
    expect(traceCount(database, 'ta')).toBe(0);

    // a run that ages past the window an hour later waits for the next day's pass
    ingestBatch(database, [obs({ obs_id: 'b', trace_id: 'tb', start: T0 - 30 * DAY - 1000, end: T0 - 30 * DAY + 1000 })], T0);
    current = T0 + 3_600_000;
    sweep.run();
    expect(traceCount(database, 'tb')).toBe(1);
    current = T0 + DAY;
    sweep.run();
    expect(traceCount(database, 'tb')).toBe(0);
  });

  it('retentionDays 0, unset, negative or NaN never prunes', () => {
    for (const retentionDays of [0, undefined, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const database = db();
      ingestBatch(database, [obs({ obs_id: 'a', trace_id: 'ta', start: T0 - 400 * DAY, end: T0 - 400 * DAY + 1 })], T0);
      const sweep = startStatusSweep(database, { intervalMs: 0, now: () => T0, ...(retentionDays !== undefined ? { retentionDays } : {}) });
      sweeps.push(sweep);
      sweep.run(T0 + 2 * DAY);
      expect(traceCount(database, 'ta')).toBe(1);
    }
  });

  it('never VACUUMs from the sweep', () => {
    const database = db();
    ingestBatch(database, [obs({ obs_id: 'a', trace_id: 'ta', start: T0 - 40 * DAY, end: T0 - 40 * DAY + 1 })], T0);
    const exec = vi.spyOn(database, 'exec');
    const sweep = startStatusSweep(database, { intervalMs: 0, now: () => T0, retentionDays: 30 });
    sweeps.push(sweep);
    expect(traceCount(database, 'ta')).toBe(0);
    sweep.run(T0 + 2 * DAY);
    expect(exec.mock.calls.some(([sql]) => /VACUUM/i.test(String(sql)))).toBe(false);
  });

  it('a failing prune pass does not break the status sweep', () => {
    const database = db();
    ingestBatch(database, [heartbeat('a1', T0)], T0);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const realPrepare = database.prepare.bind(database);
    vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM prompt_uses')) throw new Error('disk on fire');
      return realPrepare(sql);
    });
    const sweep = startStatusSweep(database, { intervalMs: 0, now: () => T0, retentionDays: 30 });
    sweeps.push(sweep);
    const result = sweep.run(T0 + 310_000);
    expect(result.transitions).toEqual([expect.objectContaining({ agent_id: 'a1', to: 'down' })]);
    expect(error.mock.calls.some((args) => String(args[0]).includes('prune'))).toBe(true);
  });
});

describe('idle sessions: the sweep session pass', () => {
  const MIN = 60_000;
  const IDLE = 30 * MIN;
  const session = (database: SqlDatabase, id: string) =>
    database.prepare('SELECT status, ended_at, updated_at FROM sessions WHERE session_id = ?').get(id);
  const sweepAt = (database: SqlDatabase, at: number, sessionIdleMs = IDLE) => {
    const sweep = startStatusSweep(database, { intervalMs: 0, now: () => at, sessionIdleMs });
    sweeps.push(sweep);
    return sweep;
  };

  it('ends a session whose traces all closed longer ago than the window, at its last activity', () => {
    const database = db();
    ingestBatch(
      database,
      [
        obs({ obs_id: 'r1', trace_id: 't1', start: T0, end: T0 + 100 }),
        obs({ obs_id: 'r2', trace_id: 't2', start: T0 + 1000, end: T0 + 5000 }),
        obs({ obs_id: 'c2', trace_id: 't2', parent_obs_id: 'r2', start: T0 + 2000, end: T0 + 3000 }),
      ],
      T0 + 5000
    );
    // still inside the window: stays active
    sweepAt(database, T0 + 5000 + IDLE - 1);
    expect(session(database, 's1')?.status).toBe('active');
    const at = T0 + 5000 + IDLE + 1;
    sweepAt(database, at);
    expect(session(database, 's1')).toMatchObject({ status: 'ended', ended_at: T0 + 5000, updated_at: at });
  });

  it('keeps a session with an open root active however old it is', () => {
    const database = db();
    ingestBatch(
      database,
      [
        obs({ obs_id: 'done', trace_id: 't1', start: T0, end: T0 + 100 }),
        obs({ obs_id: 'open', trace_id: 't2', start: T0 + 200, end: undefined, status: undefined }),
      ],
      T0
    );
    sweepAt(database, T0 + 100 * IDLE);
    expect(session(database, 's1')?.status).toBe('active');
  });

  it('falls back to updated_at for a session no observation references', () => {
    const database = db();
    database
      .prepare("INSERT INTO sessions (session_id, agent_id, started_at, ended_at, status, updated_at) VALUES ('bare', 'a1', ?, NULL, 'active', ?)")
      .run(T0, T0 + 10);
    sweepAt(database, T0 + 10 + IDLE + 1);
    expect(session(database, 'bare')).toMatchObject({ status: 'ended', ended_at: T0 + 10 });
  });

  it('an instance interrupted while its sibling stays healthy no longer holds the session open', () => {
    const database = db();
    const beat = (instance: string, ts: number, pid: number): IngestEvent => ({
      type: 'agent.heartbeat',
      data: { agent_id: 'a1', project: 'proj', name: 'a', ts, heartbeat_interval_ms: 60_000, instance_id: instance, hostname: 'h1', pid },
    });
    ingestBatch(database, [beat('A', T0, 100), beat('B', T0, 200)], T0);
    ingestBatch(database, [obs({ obs_id: 'runA', end: undefined, status: undefined, attrs: { 'lousho.instance_id': 'A' } })], T0);
    const sweep = sweepAt(database, T0);
    // only B keeps heartbeating, so the sweep interrupts A's open run
    const tick = (t: number) => {
      ingestBatch(database, [beat('B', t, 200)], t);
      sweep.run(t);
    };
    for (let t = T0 + 60_000; t <= T0 + 600_000; t += 60_000) tick(t);
    const runA = database.prepare("SELECT status, updated_at FROM observations WHERE obs_id = 'runA'").get();
    expect(runA?.status).toBe('interrupted');
    const interruptedAt = Number(runA?.updated_at);
    expect(interruptedAt).toBeGreaterThan(T0);
    // the idle window counts from the interrupt, not from the run's old start
    tick(interruptedAt + IDLE - 1);
    expect(session(database, 's1')?.status).toBe('active');
    tick(interruptedAt + IDLE + 1);
    expect(session(database, 's1')).toMatchObject({ status: 'ended', ended_at: interruptedAt });
  });

  it('an interrupted run beside a genuinely open one keeps the session active', () => {
    const database = db();
    ingestBatch(
      database,
      [
        obs({ obs_id: 'dead', trace_id: 't1', end: undefined, status: undefined }),
        obs({ obs_id: 'live', trace_id: 't2', end: undefined, status: undefined }),
      ],
      T0
    );
    database.prepare("UPDATE observations SET status = 'interrupted', updated_at = ? WHERE obs_id = 'dead'").run(T0 + 1);
    sweepAt(database, T0 + 100 * IDLE);
    expect(session(database, 's1')?.status).toBe('active');
  });

  it('a window of 0 (or unset) never ends a session', () => {
    for (const sessionIdleMs of [0, undefined]) {
      const database = db();
      ingestBatch(database, [obs()], T0);
      const sweep = startStatusSweep(database, { intervalMs: 0, now: () => T0 + 1000 * IDLE, ...(sessionIdleMs !== undefined ? { sessionIdleMs } : {}) });
      sweeps.push(sweep);
      expect(session(database, 's1')?.status).toBe('active');
    }
  });

  it('leaves interrupted sessions alone', () => {
    const database = db();
    ingestBatch(database, [obs()], T0);
    database.prepare("UPDATE sessions SET status = 'interrupted', ended_at = ? WHERE session_id = 's1'").run(T0 + 7);
    sweepAt(database, T0 + 100 * IDLE);
    expect(session(database, 's1')).toMatchObject({ status: 'interrupted', ended_at: T0 + 7 });
  });

  it('a failing session pass does not break the status sweep', () => {
    const database = db();
    ingestBatch(database, [heartbeat('a1', T0)], T0);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const realPrepare = database.prepare.bind(database);
    vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes("status = 'ended'")) throw new Error('disk on fire');
      return realPrepare(sql);
    });
    const sweep = sweepAt(database, T0);
    const result = sweep.run(T0 + 310_000);
    expect(result.transitions).toEqual([expect.objectContaining({ agent_id: 'a1', to: 'down' })]);
    expect(error.mock.calls.some((args) => String(args[0]).includes('session'))).toBe(true);
  });

  it('an ended session past the retention cutoff is pruned with its traces', () => {
    const database = db();
    const DAY = 86_400_000;
    const OLD = T0 - 40 * DAY;
    ingestBatch(database, [obs({ start: OLD, end: OLD + 100 })], OLD);
    sweepAt(database, OLD + 100 + IDLE + 1);
    expect(session(database, 's1')?.status).toBe('ended');
    expect(pruneBefore(database, T0 - 30 * DAY)).toMatchObject({ observations: 1, sessions: 1 });
    expect(session(database, 's1')).toBeUndefined();
  });
});

describe('idle sessions: the daemon window', () => {
  const MIN = 60_000;
  const seeded = (): SqlDatabase => {
    const database = db();
    ingestBatch(database, [obs()], T0);
    return database;
  };
  const status = (database: SqlDatabase) => database.prepare("SELECT status FROM sessions WHERE session_id = 's1'").get()?.status;

  it('defaults to 30 minutes', async () => {
    const database = seeded();
    const daemon = await start({ db: database, sweepIntervalMs: 0, nowFn: () => T0 + 100 + 30 * MIN - 1, retentionDays: 0 });
    expect(status(database)).toBe('active');
    daemon.sweep.run(T0 + 100 + 30 * MIN + 1);
    expect(status(database)).toBe('ended');
  });

  it('takes sessionIdleMinutes, and 0 turns the pass off', async () => {
    const custom = seeded();
    await start({ db: custom, sweepIntervalMs: 0, nowFn: () => T0 + 100 + 5 * MIN + 1, retentionDays: 0, sessionIdleMinutes: 5 });
    expect(status(custom)).toBe('ended');
    const off = seeded();
    await start({ db: off, sweepIntervalMs: 0, nowFn: () => T0 + 1000 * MIN, retentionDays: 0, sessionIdleMinutes: 0 });
    expect(status(off)).toBe('active');
  });
});
