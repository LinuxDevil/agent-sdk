/**
 * The store's contract: idempotent upserts by primary key (a resent batch
 * lands once and rollups never double count), rollup recompute correctness,
 * truncation at the 64KB field cap, and token create/verify.
 */
import { describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../storage/sqlite/driver';
import type { IngestEvent } from './envelope';
import {
  createToken,
  hasTokens,
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
