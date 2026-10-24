import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchRoute, navigate } from '../router';
import { useQueryState, useRoute } from '../useRoute';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function renderHook<T>(hook: () => T): { result: { current: T } } {
  const result = { current: undefined as T };
  const Probe = () => {
    result.current = hook();
    return null;
  };
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => root.render(createElement(Probe)));
  return { result };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  window.history.replaceState(null, '', '/?token=secret');
});
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  window.history.replaceState(null, '', '/');
});

describe('matchRoute', () => {
  it('extracts params and query', () => {
    const r = matchRoute('#/traces/abc?obs=1', ['/traces/:traceId']);
    expect(r?.path).toBe('/traces/abc');
    expect(r?.params).toEqual({ traceId: 'abc' });
    expect(r?.query.get('obs')).toBe('1');
  });
  it('returns null for unknown paths', () => {
    expect(matchRoute('#/nope', ['/traces/:traceId'])).toBeNull();
    expect(matchRoute('#/traces/a/b', ['/traces/:traceId'])).toBeNull();
  });
  it('matches static routes and an empty hash as /', () => {
    expect(matchRoute('#/settings', ['/settings'])?.params).toEqual({});
    expect(matchRoute('', ['/'])?.path).toBe('/');
  });
  it('decodes params', () => {
    expect(matchRoute('#/prompts/a%20b@v1', ['/prompts/:name'])?.params).toEqual({ name: 'a b@v1' });
  });
});

describe('navigate', () => {
  it('fires hashchange once and keeps the query string before the hash', async () => {
    const spy = vi.fn();
    window.addEventListener('hashchange', spy);
    navigate('/traces?status=error');
    await tick();
    window.removeEventListener('hashchange', spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#/traces?status=error');
    expect(window.location.search).toBe('?token=secret');
  });
  it('replace does not add a history entry', async () => {
    const before = window.history.length;
    navigate('/a');
    await tick();
    navigate('/b', { replace: true });
    await tick();
    expect(window.history.length).toBe(before + 1);
    expect(window.location.hash).toBe('#/b');
  });
});

describe('useRoute', () => {
  it('tracks hash changes', async () => {
    navigate('/settings');
    await tick();
    const { result } = renderHook(() => useRoute());
    expect(result.current.path).toBe('/settings');
    act(() => navigate('/traces?a=1'));
    await act(tick);
    expect(result.current.path).toBe('/traces');
    expect(result.current.query.get('a')).toBe('1');
  });
});

describe('useQueryState', () => {
  it('round-trips and uses replace semantics', async () => {
    navigate('/traces');
    await tick();
    const len = window.history.length;
    const { result } = renderHook(() =>
      useQueryState<number>(
        'page',
        (s) => (s === null ? 1 : Number(s)),
        (v) => (v === 1 ? null : String(v)),
      ),
    );
    expect(result.current[0]).toBe(1);
    act(() => result.current[1](3));
    await act(tick);
    expect(result.current[0]).toBe(3);
    expect(window.location.hash).toBe('#/traces?page=3');
    expect(window.history.length).toBe(len);
    act(() => result.current[1](1));
    await act(tick);
    expect(window.location.hash).toBe('#/traces');
    expect(result.current[0]).toBe(1);
  });
});
