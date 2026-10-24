/** Minimal hash router: only ever touches `location.hash`, never the query before it (the Studio token lives there). */

export type Route = { path: string; params: Record<string, string>; query: URLSearchParams };

/** Split `#/a/b?x=1` into its path and query. An empty hash is `/`. */
export function parseHash(hash: string): { path: string; query: URLSearchParams } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  return {
    path: path === '' ? '/' : path.startsWith('/') ? path : `/${path}`,
    query: new URLSearchParams(q === -1 ? '' : raw.slice(q + 1)),
  };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const segments = (p: string): string[] => p.split('/').filter(Boolean);

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const want = segments(pattern);
  const got = segments(path);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i];
    if (w.startsWith(':')) params[w.slice(1)] = decode(got[i]);
    else if (w !== got[i]) return null;
  }
  return params;
}

/** Match a hash against route patterns (`/traces/:traceId`); first match wins, `null` when none do. */
export function matchRoute(hash: string, patterns: string[]): Route | null {
  const { path, query } = parseHash(hash);
  for (const pattern of patterns) {
    const params = matchPattern(pattern, path);
    if (params) return { path, params, query };
  }
  return null;
}

/** Go to `to` (`/traces?status=error`). `replace` swaps the current history entry. Fires `hashchange` once. */
export function navigate(to: string, opts?: { replace?: boolean }): void {
  const hash = `#${to.startsWith('/') ? to : `/${to}`}`;
  if (window.location.hash === hash) return;
  if (opts?.replace) window.location.replace(hash);
  else window.location.hash = hash;
}
