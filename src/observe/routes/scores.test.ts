/**
 * `GET /api/v1/scores` read surface: row filters (trace, name, eval-name
 * prefix, agent, source, time range) and the `aggregate=eval` pass-rate
 * rollup the Studio eval-history view reads.
 */
import { describe, expect, it } from 'vitest';
import type * as http from 'node:http';
import type { IngestEvent } from '../envelope';
import { ingestBatch, openDb, type ScoreRow } from '../store';
import type { SqlDatabase } from '../../storage/sqlite/driver';
// Imported through the route registry (production's load order): importing
// './scores' first would hit the index<->feature-file cycle with scoresRoutes
// still uninitialized.
import { matchRoute } from './index';

const T0 = 1_700_000_000_000;

const score = (over: Record<string, unknown> = {}): IngestEvent => ({
  type: 'score',
  data: { score_id: `s${Math.random().toString(36).slice(2)}`, trace_id: 't1', name: 'eval-a/completed()', value: 1, source: 'eval', ts: T0, ...over },
});

function db(): SqlDatabase {
  return openDb(':memory:');
}

interface Captured {
  status: number;
  body: unknown;
}

/** Calls the route's handler with a recording ServerResponse stand-in. */
function get(database: SqlDatabase, query: string): Captured {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(chunk?: string) {
      captured.body = chunk === undefined ? undefined : JSON.parse(chunk);
    },
  } as unknown as http.ServerResponse;
  const matched = matchRoute('GET', '/api/v1/scores');
  if (!matched) throw new Error('scores route not registered');
  matched.route.handle({
    db: database,
    dbPath: ':memory:',
    req: {} as http.IncomingMessage,
    res,
    params: matched.params,
    query: new URLSearchParams(query),
    readBody: () => Promise.reject(new Error('GET has no body')),
  });
  return captured;
}

const scoresOf = (captured: Captured): ScoreRow[] => (captured.body as { scores: ScoreRow[] }).scores;

describe('GET /api/v1/scores filters', () => {
  it('filters by trace_id, name, agent_id and source', () => {
    const database = db();
    try {
      ingestBatch(database, [
        score({ score_id: 'a', trace_id: 't1', name: 'eval-a/completed()', agent_id: 'ag1' }),
        score({ score_id: 'b', trace_id: 't2', name: 'eval-a/tone', agent_id: 'ag1', source: 'judge' }),
        score({ score_id: 'c', trace_id: 't1', name: 'eval-b/completed()', agent_id: 'ag2' }),
      ]);
      expect(scoresOf(get(database, 'trace_id=t1')).map((s) => s.score_id).sort()).toEqual(['a', 'c']);
      expect(scoresOf(get(database, 'name=eval-a/tone')).map((s) => s.score_id)).toEqual(['b']);
      expect(scoresOf(get(database, 'agent_id=ag1')).map((s) => s.score_id).sort()).toEqual(['a', 'b']);
      expect(scoresOf(get(database, 'source=judge')).map((s) => s.score_id)).toEqual(['b']);
    } finally {
      database.close();
    }
  });

  it('matches the eval-name prefix with eval= (the row itself and its assertion family)', () => {
    const database = db();
    try {
      ingestBatch(database, [
        score({ score_id: 'a', name: 'refund/completed()' }),
        score({ score_id: 'b', name: 'refund/tone' }),
        score({ score_id: 'c', name: 'refund-extra/other' }),
        score({ score_id: 'd', name: 'plain' }),
      ]);
      const rows = scoresOf(get(database, 'eval=refund'));
      expect(rows.map((s) => s.score_id).sort()).toEqual(['a', 'b']);
      expect(scoresOf(get(database, 'eval=plain')).map((s) => s.score_id)).toEqual(['d']);
    } finally {
      database.close();
    }
  });

  it('bounds by created_at with since/until and honours limit', () => {
    const database = db();
    try {
      ingestBatch(database, [
        score({ score_id: 'old', ts: T0 - 10_000 }),
        score({ score_id: 'mid', ts: T0 }),
        score({ score_id: 'new', ts: T0 + 10_000 }),
      ]);
      expect(scoresOf(get(database, `since=${T0}`)).map((s) => s.score_id).sort()).toEqual(['mid', 'new']);
      expect(scoresOf(get(database, `until=${T0}`)).map((s) => s.score_id)).toEqual(['old']);
      expect(scoresOf(get(database, 'limit=1'))).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});

describe('GET /api/v1/scores?aggregate=eval', () => {
  it('groups by eval name and reports pass-rate, mean value and last-seen', () => {
    const database = db();
    try {
      ingestBatch(database, [
        // refund: two passes (one skipped-style perfect score with a comment), one failure
        score({ score_id: 'a', name: 'refund/completed()', value: 1, ts: T0 }),
        score({ score_id: 'b', name: 'refund/tone', value: 0.9, source: 'judge', ts: T0 + 1000 }),
        score({ score_id: 'c', name: 'refund/tone', value: 0.2, source: 'judge', comment: 'soft check failed', ts: T0 + 2000 }),
        score({ score_id: 'd', name: 'refund/budget', value: 1, comment: 'skipped: no cost data', ts: T0 + 3000 }),
        // greet: one failure only
        score({ score_id: 'e', name: 'greet/completed()', value: 0, comment: 'completed() failed', ts: T0 + 4000 }),
      ]);
      const res = get(database, 'aggregate=eval');
      expect(res.status).toBe(200);
      const { evals } = res.body as { evals: { name: string; count: number; passed: number; pass_rate: number; avg_value: number | null; last_ts: number }[] };
      expect(evals).toHaveLength(2);
      const greet = evals.find((e) => e.name === 'greet');
      const refund = evals.find((e) => e.name === 'refund');
      expect(greet).toMatchObject({ count: 1, passed: 0, pass_rate: 0, last_ts: T0 + 4000 });
      expect(refund).toMatchObject({ count: 4, passed: 3, pass_rate: 0.75, last_ts: T0 + 3000 });
      expect(refund?.avg_value).toBeCloseTo((1 + 0.9 + 0.2 + 1) / 4);
      // newest first
      expect(evals[0].name).toBe('greet');
    } finally {
      database.close();
    }
  });

  it('honours the same filters (agent, time range) as the row listing', () => {
    const database = db();
    try {
      ingestBatch(database, [
        score({ score_id: 'a', name: 'eval/a', agent_id: 'ag1', ts: T0 }),
        score({ score_id: 'b', name: 'eval/b', agent_id: 'ag2', ts: T0 + 999_999 }),
      ]);
      const res = get(database, `aggregate=eval&agent_id=ag1`);
      const { evals } = res.body as { evals: { name: string; count: number }[] };
      expect(evals).toEqual([{ name: 'eval', count: 1, passed: 1, pass_rate: 1, avg_value: 1, last_ts: T0 }]);
      const bounded = get(database, `aggregate=eval&until=${T0 + 1}`);
      expect((bounded.body as { evals: { count: number }[] }).evals[0].count).toBe(1);
    } finally {
      database.close();
    }
  });

  it('rejects a bad aggregate or source value with 400', () => {
    const database = db();
    try {
      expect(get(database, 'aggregate=bogus').status).toBe(400);
      expect(get(database, 'source=bogus').status).toBe(400);
    } finally {
      database.close();
    }
  });
});
