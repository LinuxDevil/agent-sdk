/**
 * The store's contract: idempotent upserts by primary key (a resent batch
 * lands once and rollups never double count), rollup recompute correctness,
 * truncation at the 64KB field cap, and token create/verify.
 */
import { describe, expect, it } from 'vitest';
import { loadDatabaseSync, type SqlDatabase } from '../storage/sqlite/driver';
import { migrate } from '../storage/sqlite/migrations';
import { migrateObserve, OBSERVE_MIGRATIONS } from './schema';
import { parseIngestEnvelope, type IngestEvent } from './envelope';
import {
  createToken,
  hasTokens,
  insightsAgents,
  ingestBatch,
  listAgents,
  listTraces,
  observeCounts,
  openDb,
  rebuildRollups,
  rollupSeries,
  traceDetail,
  transaction,
  verifyToken,
} from './store';
import { sweepAgents } from './sweep';

const T0 = 1_700_000_000_000;

function db(): SqlDatabase {
  return openDb(':memory:');
}

function obs(over: Partial<Extract<IngestEvent, { type: 'observation' }>['data']> = {}): IngestEvent {
  return {
    type: 'observation',
    data: { obs_id: 'o1', trace_id: 't1', agent_id: 'a1', kind: 'span', name: 'invoke_agent a', start: T0, end: T0 + 100, status: 'ok', ...over },
  };
}

const heartbeat = (agentId: string, ts: number, project = 'proj'): IngestEvent => ({
  type: 'agent.heartbeat',
  data: { agent_id: agentId, project, name: 'a', ts },
});

describe('openDb', () => {
  it('migrates an empty db to the observe schema', () => {
    const database = db();
    try {
      const version = database.prepare('PRAGMA user_version').get();
      expect(Number(version?.user_version)).toBeGreaterThan(0);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations'").get()).toBeDefined();
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hub_entries'").get()).toBeDefined();
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tokens'").get()).toBeDefined();
    } finally {
      database.close();
    }
  });
});

describe('prompt_labels migration', () => {
  it('backfills array-form string labels (highest version wins) and leaves record-form labels alone', () => {
    const DatabaseSync = loadDatabaseSync();
    const database = new DatabaseSync(':memory:');
    try {
      const index = OBSERVE_MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE prompt_labels'));
      expect(index).toBeGreaterThan(0);
      migrate(database, OBSERVE_MIGRATIONS.slice(0, index));
      const insert = database.prepare('INSERT INTO prompts (prompt_id, name, version, labels, created_at) VALUES (?, ?, ?, ?, ?)');
      insert.run('m1', 'mira', 1, JSON.stringify(['prod', 'canary', 7]), T0);
      insert.run('m2', 'mira', 2, JSON.stringify(['prod']), T0 + 1);
      insert.run('m3', 'mira', 3, JSON.stringify({ env: 'staging' }), T0 + 2);
      insert.run('g1', 'ghost', 1, null, T0);
      migrateObserve(database);
      const rows = database.prepare('SELECT name, label, version FROM prompt_labels ORDER BY name, label').all();
      expect(rows.map((r) => [r.name, r.label, Number(r.version)])).toEqual([
        ['mira', 'canary', 1],
        ['mira', 'prod', 2],
      ]);
      expect(database.prepare("SELECT labels FROM prompts WHERE prompt_id = 'm3'").get()?.labels).toBe(JSON.stringify({ env: 'staging' }));
    } finally {
      database.close();
    }
  });
});

describe('ingestBatch', () => {
  it('upserts: a resent batch lands one row and never double-counts rollups', () => {
    const database = db();
    try {
      const batch = [heartbeat('a1', T0), obs()];
      ingestBatch(database, batch, T0);
      ingestBatch(database, batch, T0 + 1);
      const counts = observeCounts(database);
      expect(counts.observations).toBe(1);
      expect(counts.agents).toBe(1);
      expect(rollupSeries(database, { agent_id: 'a1' }).filter((r) => r.metric === 'runs').every((r) => r.value === 1)).toBe(true);
    } finally {
      database.close();
    }
  });

  it('stores usage/cost verbatim including the partial and estimated flags', () => {
    const database = db();
    try {
      ingestBatch(database, [
        obs({
          usage_input_tokens: 11,
          usage_output_tokens: 7,
          usage_cached_tokens: 3,
          usage_reasoning_tokens: 2,
          cost_usd: 0.0042,
          cost_partial: true,
          usage_estimated: true,
          model: 'm',
        }),
      ]);
      const detail = traceDetail(database, 't1');
      const row = detail?.observations[0];
      expect(row?.usage_input_tokens).toBe(11);
      expect(row?.usage_output_tokens).toBe(7);
      expect(row?.usage_cached_tokens).toBe(3);
      expect(row?.usage_reasoning_tokens).toBe(2);
      expect(row?.cost_usd).toBe(0.0042);
      expect(row?.cost_partial).toBe(true);
      expect(row?.usage_estimated).toBe(true);
    } finally {
      database.close();
    }
  });

  it('truncates input/output at 64KB and sets the truncated flag', () => {
    const database = db();
    try {
      const big = 'x'.repeat(70 * 1024);
      ingestBatch(database, [obs({ input: big, output: 'ok' })]);
      const row = traceDetail(database, 't1')?.observations[0];
      expect(row?.input?.length).toBe(64 * 1024);
      expect(row?.output).toBe('ok');
      expect(row?.truncated).toBe(true);
    } finally {
      database.close();
    }
  });

  it('keeps an already-flagged row truncated when the strings fit', () => {
    const database = db();
    try {
      ingestBatch(database, [obs({ input: 'small', truncated: true })]);
      expect(traceDetail(database, 't1')?.observations[0]?.truncated).toBe(true);
    } finally {
      database.close();
    }
  });

  it('derives a session row from observations that carry a session_id', () => {
    const database = db();
    try {
      ingestBatch(database, [obs({ session_id: 's1' }), obs({ obs_id: 'o2', session_id: 's1', start: T0 + 50, end: T0 + 200 })]);
      const session = database.prepare('SELECT * FROM sessions WHERE session_id = ?').get('s1');
      expect(session).toBeDefined();
      expect(Number(session?.started_at)).toBe(T0);
      expect(Number(session?.ended_at)).toBe(T0 + 200);
    } finally {
      database.close();
    }
  });

  it('heartbeats upsert the agent row and keep the newest last_heartbeat', () => {
    const database = db();
    try {
      ingestBatch(database, [heartbeat('a1', T0)]);
      ingestBatch(database, [heartbeat('a1', T0 - 5000)]);
      const [agent] = listAgents(database, T0);
      expect(agent.last_heartbeat).toBe(T0);
      expect(agent.status).toBe('healthy');
      ingestBatch(database, [{ type: 'agent.deregister', data: { agent_id: 'a1', ts: T0 + 1 } }]);
      expect(listAgents(database, T0)[0].status).toBe('stopped');
    } finally {
      database.close();
    }
  });
});

describe('rollups', () => {
  it('recomputes per-agent metrics for the touched buckets only', () => {
    const database = db();
    try {
      const otherHour = T0 + 4 * 3600_000;
      ingestBatch(database, [
        obs(),
        obs({ obs_id: 'o2', status: 'error', cost_usd: 0.5, usage_input_tokens: 10, usage_output_tokens: 4 }),
        obs({ obs_id: 'o3', agent_id: 'a2' }),
        obs({ obs_id: 'o4', start: otherHour, end: otherHour + 10 }),
        // a child span (has a parent) is never a run
        obs({ obs_id: 'o5', parent_obs_id: 'o1', kind: 'tool' }),
      ]);
      const hour = T0 - (T0 % 3600_000);
      const a1 = rollupSeries(database, { agent_id: 'a1', granularity: 'hour' });
      const at = (bucket: number) => a1.filter((r) => r.bucket_start === bucket);
      const metric = (bucket: number, m: string) => at(bucket).find((r) => r.metric === m)?.value;
      expect(metric(hour, 'runs')).toBe(2);
      expect(metric(hour, 'errors')).toBe(1);
      expect(metric(hour, 'cost_usd')).toBe(0.5);
      expect(metric(hour, 'input_tokens')).toBe(10);
      expect(metric(hour, 'output_tokens')).toBe(4);
      expect(metric(hour, 'latency_ms')).toBe(200);
      expect(metric(otherHour - (otherHour % 3600_000), 'runs')).toBe(1);
      expect(rollupSeries(database, { agent_id: 'a2', granularity: 'hour' }).find((r) => r.metric === 'runs')?.value).toBe(1);
      // day granularity got the same runs
      const day = T0 - (T0 % 86_400_000);
      expect(rollupSeries(database, { agent_id: 'a1', granularity: 'day' }).find((r) => r.bucket_start === day && r.metric === 'runs')?.value).toBe(2);
    } finally {
      database.close();
    }
  });

  it('rebuildRollups restores correct rows after the table is wiped', () => {
    const database = db();
    try {
      ingestBatch(database, [obs(), obs({ obs_id: 'o2', status: 'error' })]);
      database.exec('DELETE FROM rollups');
      const { buckets } = rebuildRollups(database);
      expect(buckets).toBeGreaterThan(0);
      const rows = rollupSeries(database, { agent_id: 'a1' });
      expect(rows.find((r) => r.metric === 'runs')?.value).toBe(2);
      expect(rows.find((r) => r.metric === 'errors')?.value).toBe(1);
    } finally {
      database.close();
    }
  });
});

describe('traces read', () => {
  it('lists traces filtered by status and agent', () => {
    const database = db();
    try {
      ingestBatch(database, [
        obs(),
        obs({ obs_id: 'o2', trace_id: 't2', status: 'error' }),
        obs({ obs_id: 'o3', trace_id: 't3', agent_id: 'a2' }),
      ]);
      expect(listTraces(database, { limit: 50, offset: 0 }).total).toBe(3);
      expect(listTraces(database, { status: 'error', limit: 50, offset: 0 }).traces.map((t) => t.trace_id)).toEqual(['t2']);
      expect(listTraces(database, { agent_id: 'a2', limit: 50, offset: 0 }).total).toBe(1);
      expect(listTraces(database, { status: 'ok', limit: 50, offset: 0 }).total).toBe(2);
    } finally {
      database.close();
    }
  });
});

describe('tokens', () => {
  it('creates a hashed key that verifies, and rejects wrong or missing keys', () => {
    const database = db();
    try {
      expect(hasTokens(database)).toBe(false);
      const { key } = createToken(database, 'proj');
      expect(key.startsWith('lso_')).toBe(true);
      expect(hasTokens(database)).toBe(true);
      expect(verifyToken(database, key)).toBe(true);
      expect(verifyToken(database, 'lso_wrong')).toBe(false);
      expect(verifyToken(database, undefined)).toBe(false);
      // only the hash is stored
      const row = database.prepare('SELECT key_hash FROM tokens').get();
      expect(String(row?.key_hash)).not.toBe(key);
    } finally {
      database.close();
    }
  });
});

describe('transaction', () => {
  it('rolls the whole batch back when a write fails', () => {
    const database = db();
    try {
      expect(() =>
        transaction(database, () => {
          ingestBatchInner(database);
          throw new Error('boom');
        })
      ).toThrow('boom');
      expect(observeCounts(database).observations).toBe(0);
    } finally {
      database.close();
    }
  });
});

function ingestBatchInner(database: SqlDatabase): void {
  database.prepare("INSERT INTO observations (obs_id, trace_id, kind, start, updated_at) VALUES ('x','t','span',1,1)").run();
}

describe('eager root start (end NULL until the end event lands)', () => {
  /** A run's root start event: what the reporter sends when the root span opens. */
  const start = (over: Partial<Extract<IngestEvent, { type: 'observation' }>['data']> = {}): IngestEvent =>
    obs({ session_id: 's1', end: undefined, status: undefined, input: 'question', attrs: { phase: 'start' }, ...over });
  /** The same run's end event, carrying every column the start lacked. */
  const end = (over: Partial<Extract<IngestEvent, { type: 'observation' }>['data']> = {}): IngestEvent =>
    obs({
      session_id: 's1',
      end: T0 + 250,
      status: 'error',
      input: 'question',
      output: 'answer',
      model: 'm-2',
      usage_input_tokens: 21,
      usage_output_tokens: 8,
      usage_cached_tokens: 4,
      usage_reasoning_tokens: 3,
      cost_usd: 0.25,
      cost_partial: true,
      usage_estimated: true,
      attrs: { phase: 'end' },
      ...over,
    });
  const row = (database: SqlDatabase) => traceDetail(database, 't1')?.observations[0];
  const finished = {
    end: T0 + 250,
    status: 'error',
    output: 'answer',
    model: 'm-2',
    usage_input_tokens: 21,
    usage_output_tokens: 8,
    usage_cached_tokens: 4,
    usage_reasoning_tokens: 3,
    cost_usd: 0.25,
    cost_partial: true,
    usage_estimated: true,
    attrs: { phase: 'end' },
  };
  const hourMetric = (database: SqlDatabase, metric: string) =>
    rollupSeries(database, { agent_id: 'a1', granularity: 'hour' }).find((r) => r.metric === metric)?.value;

  it('a start event then an end event yields one row with the end values', () => {
    const database = db();
    try {
      ingestBatch(database, [start()], T0);
      expect(row(database)).toMatchObject({ end: null, status: null, output: null, cost_usd: null });
      ingestBatch(database, [end()], T0 + 300);
      expect(row(database)).toMatchObject(finished);
      expect(observeCounts(database)).toMatchObject({ observations: 1, traces: 1, sessions: 1 });
      const { traces, total } = listTraces(database, { limit: 50, offset: 0 });
      expect(total).toBe(1);
      expect(traces[0]).toMatchObject({ status: 'error', observations: 1, end: T0 + 250, cost_usd: 0.25, input_tokens: 21 });
      // one run in the rollups, with the end event's numbers
      expect(hourMetric(database, 'runs')).toBe(1);
      expect(hourMetric(database, 'errors')).toBe(1);
      expect(hourMetric(database, 'cost_usd')).toBe(0.25);
      expect(hourMetric(database, 'latency_ms')).toBe(250);
      expect(Number(database.prepare("SELECT ended_at FROM sessions WHERE session_id = 's1'").get()?.ended_at)).toBe(T0 + 250);
    } finally {
      database.close();
    }
  });

  it('a start event arriving after its end event (a requeue reordered them) cannot reopen the finished row', () => {
    const database = db();
    try {
      ingestBatch(database, [end()], T0);
      ingestBatch(database, [start()], T0 + 300);
      expect(row(database)).toMatchObject(finished);
      expect(listTraces(database, { limit: 50, offset: 0 }).traces[0].status).toBe('error');
      expect(hourMetric(database, 'runs')).toBe(1);
      expect(hourMetric(database, 'latency_ms')).toBe(250);
      // the same order inside one batch
      const other = db();
      try {
        ingestBatch(other, [end(), start()], T0);
        expect(row(other)).toMatchObject(finished);
      } finally {
        other.close();
      }
    } finally {
      database.close();
    }
  });

  it('lists an open root as running, not ok or error, and keeps it out of latency', () => {
    const database = db();
    try {
      ingestBatch(database, [
        start(),
        // a child already failed: the run is still running, the root decides
        obs({ obs_id: 'c1', parent_obs_id: 'o1', kind: 'tool', status: 'error' }),
        obs({ obs_id: 'o2', trace_id: 't2', end: T0 + 40, status: 'ok' }),
      ]);
      const list = (status?: string) => listTraces(database, { ...(status ? { status } : {}), limit: 50, offset: 0 });
      expect(list().traces.find((t) => t.trace_id === 't1')?.status).toBe('running');
      expect(list('running').traces.map((t) => t.trace_id)).toEqual(['t1']);
      expect(list('ok').traces.map((t) => t.trace_id)).toEqual(['t2']);
      expect(list('error').total).toBe(0);
      const [agent] = insightsAgents(database, { since: T0 - 1, until: T0 + 86_400_000 });
      expect(agent).toMatchObject({ runs: 2, errors: 0, p50_latency_ms: 40, p95_latency_ms: 40 });
    } finally {
      database.close();
    }
  });

  it('sweep marks an open root observation interrupted when its agent goes down', () => {
    const database = db();
    try {
      ingestBatch(database, [heartbeat('a1', T0), start()], T0);
      expect(listTraces(database, { limit: 50, offset: 0 }).traces[0].status).toBe('running');
      const result = sweepAgents(database, T0 + 400_000);
      expect(result.transitions[0]).toMatchObject({ agent_id: 'a1', to: 'down', crashed: true });
      expect(row(database)).toMatchObject({ status: 'interrupted', end: null });
      expect(listTraces(database, { limit: 50, offset: 0 }).traces[0].status).toBe('interrupted');
      expect(listTraces(database, { status: 'interrupted', limit: 50, offset: 0 }).total).toBe(1);
      // a requeued start resent after the agent woke up keeps the verdict ...
      ingestBatch(database, [start()], T0 + 400_100);
      expect(row(database)?.status).toBe('interrupted');
      // ... until the run's real end lands and settles it
      ingestBatch(database, [end()], T0 + 400_200);
      expect(row(database)).toMatchObject(finished);
    } finally {
      database.close();
    }
  });

  it("a deregister interrupts the agent's runs that never ended (closed mid-run)", () => {
    const database = db();
    try {
      ingestBatch(database, [heartbeat('a1', T0), start(), obs({ obs_id: 'o2', trace_id: 't2' }), obs({ obs_id: 'x', trace_id: 't3', agent_id: 'a2', end: undefined, status: undefined })], T0);
      ingestBatch(database, [{ type: 'agent.deregister', data: { agent_id: 'a1', ts: T0 + 5_000 } }], T0 + 5_000);
      expect(row(database)).toMatchObject({ status: 'interrupted', end: null });
      expect(traceDetail(database, 't2')?.observations[0].status).toBe('ok');
      expect(traceDetail(database, 't3')?.observations[0].status).toBeNull(); // another agent's run is untouched
    } finally {
      database.close();
    }
  });
});

describe('agent instances (one agent_id, several processes over time)', () => {
  /** A heartbeat of agent a1 from one process: `instance` on `host`/`pid`. */
  const beat = (instance: string | undefined, ts: number, proc: { host?: string; pid?: number; interval?: number } = {}): IngestEvent => ({
    type: 'agent.heartbeat',
    data: {
      agent_id: 'a1',
      project: 'proj',
      name: 'a',
      ts,
      heartbeat_interval_ms: proc.interval ?? 60_000,
      ...(instance !== undefined ? { instance_id: instance } : {}),
      ...(proc.host !== undefined ? { hostname: proc.host } : {}),
      ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
    },
  });
  /** An open run root started by `instance` (the reporter stamps it in attrs). */
  const openRoot = (obsId: string, instance?: string): IngestEvent =>
    obs({ obs_id: obsId, trace_id: `t-${obsId}`, end: undefined, status: undefined, attrs: instance !== undefined ? { 'lousho.instance_id': instance } : {} });
  const statusOf = (database: SqlDatabase, obsId: string) =>
    database.prepare('SELECT status FROM observations WHERE obs_id = ?').get(obsId)?.status ?? null;
  const traceStatus = (database: SqlDatabase, obsId: string) =>
    listTraces(database, { limit: 50, offset: 0 }).traces.find((t) => t.trace_id === `t-${obsId}`)?.status;
  const instances = (database: SqlDatabase) =>
    database.prepare('SELECT instance_id FROM agent_instances ORDER BY instance_id').all().map((r) => r.instance_id);
  const hostA = { host: 'h1', pid: 100 };
  const hostB = { host: 'h1', pid: 200 };

  it('siblings heartbeating side by side never interrupt each other', () => {
    const database = db();
    try {
      ingestBatch(database, [beat('A', T0, hostA), openRoot('runA', 'A')], T0);
      ingestBatch(database, [beat('B', T0 + 1_000, hostB), openRoot('runB', 'B')], T0 + 1_000);
      for (let t = 60_000; t <= 600_000; t += 60_000) {
        ingestBatch(database, [beat('A', T0 + t, hostA), beat('B', T0 + t + 1_000, hostB)], T0 + t + 1_000);
        sweepAgents(database, T0 + t + 30_000);
      }
      expect([traceStatus(database, 'runA'), traceStatus(database, 'runB')]).toEqual(['running', 'running']);
      expect(instances(database)).toEqual(['A', 'B']);
    } finally {
      database.close();
    }
  });

  it('a restart on the same host and pid interrupts the silent old instance once it missed a beat (interval + slack)', () => {
    const database = db();
    try {
      const c1 = { host: 'c1', pid: 1 }; // a container restarted: pid 1 again
      ingestBatch(database, [beat('A', T0, c1), openRoot('runA', 'A')], T0);
      ingestBatch(database, [beat('B', T0 + 1_000, c1), openRoot('runB', 'B')], T0 + 1_000);
      // one heartbeat proves nothing: a live twin in another pid namespace looks the same
      expect(traceStatus(database, 'runA')).toBe('running');
      ingestBatch(database, [beat('B', T0 + 61_000, c1)], T0 + 61_000);
      // 61s since A's last beat is still a live gap (beats ride the 5s flush tick)
      expect(traceStatus(database, 'runA')).toBe('running');
      ingestBatch(database, [beat('B', T0 + 121_000, c1)], T0 + 121_000);
      // A stayed silent since before B was first seen, past interval + slack: it is the process B replaced
      expect(traceStatus(database, 'runA')).toBe('interrupted');
      expect(traceStatus(database, 'runB')).toBe('running');
      expect(instances(database)).toEqual(['B']);
    } finally {
      database.close();
    }
  });

  it('twins on one host and pid (separate pid namespaces) heartbeating side by side never interrupt each other', () => {
    const database = db();
    try {
      const pid1 = { host: 'node-1', pid: 1 }; // two --network host replicas: same hostname, both pid 1
      ingestBatch(database, [beat('A', T0, pid1), openRoot('runA', 'A')], T0);
      ingestBatch(database, [beat('B', T0 + 30_000, pid1), openRoot('runB', 'B')], T0 + 30_000);
      for (let t = 60_000; t <= 900_000; t += 60_000) {
        ingestBatch(database, [beat('A', T0 + t, pid1)], T0 + t);
        ingestBatch(database, [beat('B', T0 + t + 30_000, pid1)], T0 + t + 30_000);
        sweepAgents(database, T0 + t + 45_000);
      }
      expect([traceStatus(database, 'runA'), traceStatus(database, 'runB')]).toEqual(['running', 'running']);
      expect(instances(database)).toEqual(['A', 'B']);
    } finally {
      database.close();
    }
  });

  it('twins started 300ms apart never interrupt each other when one beat lands a flush tick late', () => {
    const database = db();
    try {
      const pid1 = { host: 'node-1', pid: 1 };
      ingestBatch(database, [beat('A', T0, pid1), openRoot('runA', 'A')], T0);
      ingestBatch(database, [beat('B', T0 + 300, pid1), openRoot('runB', 'B')], T0 + 300);
      for (let t = 60_000; t <= 600_000; t += 60_000) {
        // B's beat lands first; A's rides its next 5s flush tick, ~4s late
        ingestBatch(database, [beat('B', T0 + t + 300, pid1)], T0 + t + 300);
        ingestBatch(database, [beat('A', T0 + t + 4_300, pid1)], T0 + t + 4_300);
      }
      expect([traceStatus(database, 'runA'), traceStatus(database, 'runB')]).toEqual(['running', 'running']);
      expect(instances(database)).toEqual(['A', 'B']);
    } finally {
      database.close();
    }
  });

  it("a dead instance's delayed final heartbeat landing after its same-pid successor started cannot interrupt the successor", () => {
    const database = db();
    try {
      const c1 = { host: 'c1', pid: 1 };
      ingestBatch(database, [beat('A', T0, c1), openRoot('runA', 'A')], T0);
      ingestBatch(database, [beat('B', T0 + 1_000, c1), openRoot('runB', 'B')], T0 + 1_000);
      // A's last words (stamped earlier, delivered late) arrive after B registered
      ingestBatch(database, [beat('A', T0 + 500, c1)], T0 + 2_000);
      ingestBatch(database, [beat('B', T0 + 61_000, c1)], T0 + 61_000);
      expect(traceStatus(database, 'runB')).toBe('running');
      // A spoke after B was first seen, so the shortcut leaves it; the sweep catches it at stale
      expect(traceStatus(database, 'runA')).toBe('running');
      ingestBatch(database, [beat('B', T0 + 121_000, c1)], T0 + 121_000);
      sweepAgents(database, T0 + 135_000);
      expect(traceStatus(database, 'runA')).toBe('interrupted');
      expect(traceStatus(database, 'runB')).toBe('running');
    } finally {
      database.close();
    }
  });

  it("judges each instance's silence against its own heartbeat interval", () => {
    const database = db();
    try {
      const fast = { host: 'h1', pid: 10, interval: 10_000 };
      const slow = { host: 'h1', pid: 60, interval: 60_000 };
      ingestBatch(database, [beat('S', T0, slow), openRoot('runS', 'S')], T0);
      ingestBatch(database, [beat('S', T0 + 60_000, slow)], T0 + 60_000);
      for (let t = 0; t <= 120_000; t += 10_000) ingestBatch(database, [beat('F', T0 + t, fast)], T0 + t); // the agent row now says 10s
      // S is 60s quiet: past 2 x 10s + 10s, well within its own 2 x 60s + 10s
      sweepAgents(database, T0 + 120_000);
      expect(traceStatus(database, 'runS')).toBe('running');
      expect(instances(database)).toEqual(['F', 'S']);
    } finally {
      database.close();
    }
  });

  it("judges silence by the daemon's receive time, not the reporter's clock", () => {
    const database = db();
    try {
      const behind = 15 * 60_000; // B's clock runs 15 minutes slow
      ingestBatch(database, [beat('A', T0, hostA), beat('B', T0 - behind, hostB), openRoot('runB', 'B')], T0);
      for (let t = 60_000; t <= 300_000; t += 60_000) {
        ingestBatch(database, [beat('A', T0 + t, hostA), beat('B', T0 + t - behind, hostB)], T0 + t);
        sweepAgents(database, T0 + t + 5_000);
      }
      expect(traceStatus(database, 'runB')).toBe('running');
      expect(instances(database)).toEqual(['A', 'B']);
    } finally {
      database.close();
    }
  });

  it('a restart under a new pid interrupts the old instance once it passes stale while the new one is healthy', () => {
    const database = db();
    try {
      ingestBatch(database, [beat('A', T0, hostA), openRoot('runA', 'A')], T0);
      // A is SIGKILLed; B starts at once and keeps heartbeating
      for (let t = 1_000; t <= 241_000; t += 60_000) ingestBatch(database, [beat('B', T0 + t, hostB)], T0 + t);
      ingestBatch(database, [openRoot('runB', 'B')], T0 + 1_000);
      sweepAgents(database, T0 + 125_000); // A 125s quiet: within 2 x 60s + 10s
      expect(statusOf(database, 'runA')).toBeNull();
      const result = sweepAgents(database, T0 + 135_000); // past the stale boundary
      expect(result.transitions).toHaveLength(0); // the agent itself stays healthy
      expect(traceStatus(database, 'runA')).toBe('interrupted');
      expect(traceStatus(database, 'runB')).toBe('running');
      expect(instances(database)).toEqual(['B']);
    } finally {
      database.close();
    }
  });

  it('leaves a silent instance to the agent-level down path when no process of the agent is healthy', () => {
    const database = db();
    try {
      ingestBatch(database, [beat('A', T0, hostA), openRoot('runA', 'A')], T0);
      sweepAgents(database, T0 + 200_000); // stale, but nobody else is alive: not a verdict yet
      expect(statusOf(database, 'runA')).toBeNull();
      const result = sweepAgents(database, T0 + 400_000);
      expect(result.transitions[0]).toMatchObject({ to: 'down', crashed: true });
      expect(statusOf(database, 'runA')).toBe('interrupted');
      expect(instances(database)).toEqual([]); // a down agent's instances are all gone
    } finally {
      database.close();
    }
  });

  it('a late heartbeat from an instance already forgotten interrupts nothing', () => {
    const database = db();
    try {
      ingestBatch(database, [beat('A', T0, hostA), beat('B', T0, hostB), openRoot('runB', 'B')], T0);
      ingestBatch(database, [{ type: 'agent.deregister', data: { agent_id: 'a1', ts: T0 + 1_000, instance_id: 'A' } }], T0 + 1_000);
      expect(instances(database)).toEqual(['B']);
      // a requeued heartbeat of A lands after its deregister: A looks new again
      ingestBatch(database, [beat('A', T0 + 500, hostA)], T0 + 2_000);
      expect(traceStatus(database, 'runB')).toBe('running');
    } finally {
      database.close();
    }
  });

  it('a deregister interrupts only the closing instance', () => {
    const database = db();
    try {
      ingestBatch(database, [beat('A', T0, hostA), beat('B', T0, hostB), openRoot('runA', 'A'), openRoot('runB', 'B')], T0);
      ingestBatch(database, [{ type: 'agent.deregister', data: { agent_id: 'a1', ts: T0 + 5_000, instance_id: 'A' } }], T0 + 5_000);
      expect(statusOf(database, 'runA')).toBe('interrupted');
      expect(traceStatus(database, 'runB')).toBe('running');
    } finally {
      database.close();
    }
  });

  it('an old-style open root (no instance_id) keeps the agent-level rules', () => {
    const database = db();
    try {
      ingestBatch(database, [beat(undefined, T0), openRoot('old')], T0);
      // a new instance appearing does not touch it: nothing says which process started it
      ingestBatch(database, [beat('B', T0 + 1_000, hostB)], T0 + 1_000);
      sweepAgents(database, T0 + 135_000);
      expect(statusOf(database, 'old')).toBeNull();
      // the agent going down still interrupts it
      sweepAgents(database, T0 + 400_000);
      expect(statusOf(database, 'old')).toBe('interrupted');
    } finally {
      database.close();
    }
  });

  it('treats an empty instance_id as absent instead of refusing the batch', () => {
    expect(parseIngestEnvelope({ batch: [beat('', T0, hostA)] }).ok).toBe(true);
    const database = db();
    try {
      ingestBatch(database, [beat('', T0, hostA), openRoot('blank', '')], T0);
      expect(instances(database)).toEqual([]);
      expect(database.prepare("SELECT instance_id FROM observations WHERE obs_id = 'blank'").get()?.instance_id).toBeNull();
    } finally {
      database.close();
    }
  });
});

describe('latency rollup', () => {
  it('leaves open runs out of latency_ms', () => {
    const database = db();
    try {
      ingestBatch(database, [obs({ obs_id: 'open', trace_id: 't-open', end: undefined, status: undefined })]);
      const metric = (m: string) => rollupSeries(database, { agent_id: 'a1', granularity: 'hour' }).find((r) => r.metric === m)?.value;
      expect(metric('runs')).toBe(1);
      expect(metric('latency_ms')).toBe(0); // no finished run yet (and no NOT NULL violation)
      ingestBatch(database, [obs({ obs_id: 'done', start: T0, end: T0 + 70 })]);
      expect(metric('latency_ms')).toBe(70);
    } finally {
      database.close();
    }
  });
});
