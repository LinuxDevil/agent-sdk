import { useCallback, useRef, useSyncExternalStore } from 'react';
import { navigate, parseHash, type Route } from './router';

let cachedHash: string | null = null;
let cachedRoute: Route = { path: '/', params: {}, query: new URLSearchParams() };

// useSyncExternalStore needs a referentially stable snapshot between hash changes.
function getSnapshot(): Route {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = { ...parseHash(hash), params: {} };
  }
  return cachedRoute;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

/** The current hash route (path + query; `params` is empty — use `matchRoute` with patterns for those). */
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** One query-string key held in the URL hash, updated with replace semantics. `format` returning null drops the key. */
export function useQueryState<T>(
  key: string,
  parse: (s: string | null) => T,
  format: (v: T) => string | null,
): [T, (v: T) => void] {
  const route = useRoute();
  // Held in a ref so the setter keeps its identity when callers pass inline lambdas.
  const formatRef = useRef(format);
  formatRef.current = format;
  const value = parse(route.query.get(key));
  const set = useCallback(
    (v: T) => {
      const { path, query } = parseHash(window.location.hash);
      const next = new URLSearchParams(query);
      const s = formatRef.current(v);
      if (s === null) next.delete(key);
      else next.set(key, s);
      const qs = next.toString();
      navigate(qs ? `${path}?${qs}` : path, { replace: true });
    },
    [key],
  );
  return [value, set];
}
