/**
 * The segment matcher behind every daemon route: literal paths match,
 * `:param` segments capture one decoded segment, and method, segment count
 * or a literal miss return `undefined`.
 */
import { describe, expect, it } from 'vitest';
import { matchRoute } from './index';

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
