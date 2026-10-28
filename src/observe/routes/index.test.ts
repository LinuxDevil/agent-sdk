/**
 * The segment matcher behind every daemon route: literal paths match,
 * `:param` segments capture one decoded segment, and method, segment count
 * or a literal miss return `undefined`.
 */
import { startEvaluatorWorker } from '../evaluatorWorker';
import { describe, expect, it } from 'vitest';
import { openDb } from '../store';
import { matchRoute, type RouteContext } from './index';

describe('matchRoute', () => {
  it('matches a literal path', () => {
    const hit = matchRoute('GET', '/health');
    expect(hit?.route.path).toBe('/health');
    expect(hit?.params).toEqual({});
  });

  it('captures :param segments, URI-decoded', () => {
    const hit = matchRoute('GET', '/api/v1/traces/abc%2Fdef');
    expect(hit?.route.path).toBe('/api/v1/traces/:id');
    expect(hit?.params).toEqual({ id: 'abc/def' });
  });

  it('misses on a different method, a different segment count, or a literal mismatch', () => {
    expect(matchRoute('DELETE', '/api/v1/traces/x')).toBeUndefined();
    expect(matchRoute('GET', '/api/v1/traces/x/extra')).toBeUndefined();
    expect(matchRoute('GET', '/api/v2/traces')).toBeUndefined();
    expect(matchRoute('GET', '/api/v1/nope')).toBeUndefined();
  });
});

describe('GET /api/v1/traces query params', () => {
  // drive the matched handler directly with a recording response
  const call = (search: string): { status: number; body: Record<string, unknown> } => {
    const hit = matchRoute('GET', '/api/v1/traces');
    if (!hit) throw new Error('no route');
    let status = 0;
    let text = '';
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: (t: string) => {
        text = t;
      },
    } as unknown as RouteContext['res'];
    const db = openDb(':memory:');
    try {
      void hit.route.handle({
        db,
        dbPath: ':memory:',
        evaluators: startEvaluatorWorker(db),
        req: {} as RouteContext['req'],
        res,
        params: hit.params,
        query: new URLSearchParams(search),
        readBody: () => Promise.resolve(''),
      });
    } finally {
      db.close();
    }
    return { status, body: JSON.parse(text) as Record<string, unknown> };
  };

  it('accepts the filter, search and sort params', () => {
    const { status, body } = call('from=1&to=2&q=ord_5&min_duration_ms=10&model=m&sort=duration&order=asc&prompt=mira@2');
    expect(status).toBe(200);
    expect(body).toMatchObject({ traces: [], total: 0 });
  });

  it('accepts prompt=<name> without a version', () => {
    expect(call('prompt=mira').status).toBe(200);
  });

  it.each(['sort=bogus', 'order=sideways', 'min_duration_ms=fast', 'prompt=', 'prompt=mira@', 'prompt=mira@two', 'prompt=@2', 'prompt=mira@1.5'])('rejects %s with 400 LOUSHO_REQUEST_INVALID', (search) => {
    const { status, body } = call(search);
    expect(status).toBe(400);
    expect(body.code).toBe('LOUSHO_REQUEST_INVALID');
  });
});

interface ApiBody {
  total: number;
  code: string;
  session: { session_id: string };
  sessions: { session_id: string }[];
  traces: { trace_id: string }[];
}

describe('sessions API', () => {
  const call = (path: string, search: string, db: ReturnType<typeof openDb>): { status: number; body: ApiBody } => {
    const hit = matchRoute('GET', path);
    if (!hit) throw new Error('no route');
    let status = 0;
    let text = '';
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: (t: string) => {
        text = t;
      },
    } as unknown as RouteContext['res'];
    void hit.route.handle({
      db,
      dbPath: ':memory:',
      evaluators: startEvaluatorWorker(db),
      req: {} as RouteContext['req'],
      res,
      params: hit.params,
      query: new URLSearchParams(search),
      readBody: () => Promise.resolve(''),
    });
    return { status, body: JSON.parse(text) as ApiBody };
  };

  const seed = (db: ReturnType<typeof openDb>): void => {
    db.prepare("INSERT INTO agents (agent_id, name, first_seen, status, updated_at) VALUES ('a1', 'Helper', 1, 'healthy', 1)").run();
    const session = db.prepare("INSERT INTO sessions (session_id, agent_id, started_at, ended_at, status, updated_at) VALUES (?, ?, ?, ?, ?, 1)");
    session.run('s1', 'a1', 1000, 3000, 'active');
    session.run('s2', 'a1', 5000, null, 'interrupted');
    const obs = db.prepare(
      'INSERT INTO observations (obs_id, trace_id, session_id, agent_id, parent_obs_id, kind, name, start, "end", status, input, usage_input_tokens, usage_output_tokens, cost_usd, updated_at) ' +
        "VALUES (?, ?, 's1', 'a1', ?, ?, 'n', ?, ?, 'ok', ?, ?, ?, ?, 1)"
    );
    // trace t2 starts first on purpose: the order must come from start, not insertion
    obs.run('t2-root', 't2', null, 'span', 2000, 3000, 'x'.repeat(300), null, null, null);
    obs.run('t2-gen', 't2', 't2-root', 'generation', 2100, 2900, null, 5, 7, 0.5);
    obs.run('t1-root', 't1', null, 'span', 1000, 1500, 'first', null, null, null);
    obs.run('t1-gen', 't1', 't1-root', 'generation', 1100, 1400, null, 10, 20, 1);
  };

  it('lists sessions newest first with totals, names and filters', () => {
    const db = openDb(':memory:');
    try {
      seed(db);
      const { status, body } = call('/api/v1/sessions', '', db);
      expect(status).toBe(200);
      expect(body).toMatchObject({ total: 2, limit: 50, offset: 0 });
      expect(body.sessions.map((s) => s.session_id)).toEqual(['s2', 's1']);
      expect(body.sessions[1]).toEqual({
        session_id: 's1',
        agent_id: 'a1',
        agent_name: 'Helper',
        status: 'active',
        started_at: 1000,
        ended_at: 3000,
        traces: 2,
        input_tokens: 15,
        output_tokens: 27,
        cost_usd: 1.5,
        last_input_preview: 'x'.repeat(200),
      });
      expect(body.sessions[0]).toMatchObject({ traces: 0, input_tokens: 0, cost_usd: 0, last_input_preview: null, ended_at: null });
      expect(call('/api/v1/sessions', 'status=interrupted', db).body.total).toBe(1);
      expect(call('/api/v1/sessions', 'from=1000&to=5000', db).body.sessions.map((s) => s.session_id)).toEqual(['s1']);
      expect(call('/api/v1/sessions', 'agent_id=nope', db).body.total).toBe(0);
      expect(call('/api/v1/sessions', 'limit=1&offset=1', db).body.sessions.map((s) => s.session_id)).toEqual(['s1']);
    } finally {
      db.close();
    }
  });

  it('returns one session with its traces ordered by start ascending', () => {
    const db = openDb(':memory:');
    try {
      seed(db);
      const { status, body } = call('/api/v1/sessions/s1', '', db);
      expect(status).toBe(200);
      expect(body.session.session_id).toBe('s1');
      expect(body.traces.map((t) => t.trace_id)).toEqual(['t1', 't2']);
    } finally {
      db.close();
    }
  });

  it('404s an unknown session', () => {
    const db = openDb(':memory:');
    try {
      const { status, body } = call('/api/v1/sessions/nope', '', db);
      expect(status).toBe(404);
      expect(body.code).toBe('LOUSHO_REQUEST_INVALID');
    } finally {
      db.close();
    }
  });
});
