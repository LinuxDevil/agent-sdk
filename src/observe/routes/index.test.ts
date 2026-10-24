/**
 * The segment matcher behind every daemon route: literal paths match,
 * `:param` segments capture one decoded segment, and method, segment count
 * or a literal miss return `undefined`.
 */
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
    const { status, body } = call('from=1&to=2&q=ord_5&min_duration_ms=10&model=m&sort=duration&order=asc');
    expect(status).toBe(200);
    expect(body).toMatchObject({ traces: [], total: 0 });
  });

  it.each(['sort=bogus', 'order=sideways', 'min_duration_ms=fast'])('rejects %s with 400 LOUSHO_REQUEST_INVALID', (search) => {
    const { status, body } = call(search);
    expect(status).toBe(400);
    expect(body.code).toBe('LOUSHO_REQUEST_INVALID');
  });
});
