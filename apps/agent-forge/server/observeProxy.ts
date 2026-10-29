/**
 * `/observe/**` -> the observe daemon's read API (`src/observe/routes/*`).
 *
 * The daemon binds loopback (default `http://127.0.0.1:7777`) and sends no
 * CORS headers, so the Studio panels can't fetch it cross-origin; the
 * studio server forwards its GETs same-origin instead, keeping the
 * "daemon owns the only db handle" rule - this proxy pipes, it never reads
 * the file. `LOUSHO_OBSERVE_URL` repoints the upstream (another port, or a
 * hosted collector implementing the same ingest/read API).
 *
 * GET is forwarded for every path. Writes are forwarded only when
 * {@link OBSERVE_WRITE_ALLOWLIST} names the method and path - a short list of
 * Studio actions (human feedback scores, a new prompt version from the
 * playground, moving a prompt label, editing a Context Hub fleet entry,
 * dataset and example writes, annotation queue writes, online evaluator rule
 * create/update/delete) - with the JSON body app.ts's `express.json` already
 * parsed, re-serialised and capped at 1 MiB (a DELETE forwards no body, and
 * its 204 passes back empty). Every other method (HEAD, OPTIONS and PATCH
 * included) - and every non-GET to an unlisted path, the ingest endpoint
 * above all - answers 405 and stays reporter-only. The allowlist is
 * case-sensitive, so `/API/v1/scores` or a trailing `/` is unlisted. (`POST
 * /observe/api/v1/evaluators/:id/test` never reaches this proxy: app.ts
 * registers judge.ts's route for it first.)
 *
 * The upstream URL is built from the routed path and query only
 * ({@link observeUpstreamUrl}) - never the request line's authority, so an
 * absolute-form `GET http://a@evil.example/observe/...` still goes to the
 * target - and anything that would resolve off the target's origin (or out
 * of its base path) answers 400 without a fetch. The daemon gets
 * `LOUSHO_OBSERVE_TOKEN` as its bearer when set ({@link daemonHeaders}), on
 * reads and writes alike; the client's own Authorization, cookies and Studio
 * token are never forwarded. `/observe` sits in app.ts's API_PREFIXES, so it
 * carries the same per-launch token requirement as the rest of the studio
 * API.
 */
import type { Express, Request } from 'express';

const DEFAULT_OBSERVE_URL = 'http://127.0.0.1:7777';
const PROXY_PREFIX = '/observe';
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_WRITE_BODY_BYTES = 1024 * 1024;

/** A daemon write the proxy forwards: the method plus a regex over the path after `/observe` (no query). */
export interface ObserveWrite {
  method: 'POST' | 'PUT' | 'DELETE';
  path: RegExp;
}

/** The only non-GET requests the proxy forwards; a later Studio write is one more line here. */
export const OBSERVE_WRITE_ALLOWLIST: readonly ObserveWrite[] = [
  { method: 'POST', path: /^\/api\/v1\/scores$/ },
  { method: 'POST', path: /^\/api\/v1\/prompts$/ },
  { method: 'PUT', path: /^\/api\/v1\/prompts\/[^/]+\/labels\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/v1\/hub$/ },
  { method: 'POST', path: /^\/api\/v1\/datasets$/ },
  { method: 'POST', path: /^\/api\/v1\/datasets\/[^/]+\/examples$/ },
  { method: 'DELETE', path: /^\/api\/v1\/datasets\/[^/]+\/examples\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/v1\/queues$/ },
  { method: 'POST', path: /^\/api\/v1\/queues\/[^/]+\/items$/ },
  { method: 'POST', path: /^\/api\/v1\/queues\/[^/]+\/items\/[^/]+\/complete$/ },
  { method: 'POST', path: /^\/api\/v1\/evaluators$/ },
  { method: 'PUT', path: /^\/api\/v1\/evaluators\/[^/]+$/ },
  { method: 'DELETE', path: /^\/api\/v1\/evaluators\/[^/]+$/ },
];

/**
 * A raw path segment the daemon would decode into something other than one
 * plain name: `.`/`..` (literal or percent-encoded), a literal or encoded `\`
 * (URL parsing reads `\` as `/` for http(s)), an encoded `/`, or an
 * undecodable escape. The allowlist regexes only see raw segments.
 */
function isUnsafeSegment(raw: string): boolean {
  if (raw.includes('\\') || /%2f|%5c/i.test(raw)) return true;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded === '.' || decoded === '..';
  } catch {
    return true;
  }
}

const isAllowedWrite = (req: Request): boolean =>
  !req.path.split('/').some(isUnsafeSegment) &&
  OBSERVE_WRITE_ALLOWLIST.some((entry) => entry.method === req.method && entry.path.test(req.path));

/** The JSON body to forward (express.json() already parsed it), or `undefined` when it is over the cap. */
function writeBody(req: Request): string | undefined {
  const body = JSON.stringify(req.body ?? {});
  return Buffer.byteLength(body, 'utf8') > MAX_WRITE_BODY_BYTES ? undefined : body;
}

/** The daemon the Studio reads (and playground runs report to): `LOUSHO_OBSERVE_URL`, default loopback :7777. */
export function observeTarget(): string {
  return (process.env.LOUSHO_OBSERVE_URL ?? DEFAULT_OBSERVE_URL).replace(/\/+$/, '');
}

/**
 * Headers for a server-side daemon call: `accept` (plus `content-type` when
 * a JSON body goes with it) and the bearer `LOUSHO_OBSERVE_TOKEN` names.
 */
export function daemonHeaders(jsonBody = true): Record<string, string> {
  const token = process.env.LOUSHO_OBSERVE_TOKEN;
  return {
    accept: 'application/json',
    ...(jsonBody ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * The daemon URL for a proxied request: {@link observeTarget} plus the path
 * after `/observe` and the raw query. `undefined` when the result would leave
 * the target (another origin, userinfo) or URL parsing would rewrite the path
 * at all (`.`/`..` or `%2e` segments, `\` read as `/`) - the upstream path must
 * be exactly the target's base path + `routedPath` - so the caller refuses
 * rather than fetching it, whatever the method.
 */
export function observeUpstreamUrl(routedPath: string, search: string): URL | undefined {
  if (!routedPath.startsWith('/') || (search !== '' && !search.startsWith('?'))) return undefined;
  try {
    const target = new URL(observeTarget());
    const upstream = new URL(`${observeTarget()}${routedPath}${search}`);
    const base = target.pathname.replace(/\/+$/, '');
    const unchangedPath = upstream.pathname === `${base}${routedPath}`;
    const sameOrigin = upstream.origin === target.origin && upstream.username === '' && upstream.password === '';
    return sameOrigin && unchangedPath ? upstream : undefined;
  } catch {
    return undefined;
  }
}

/** The raw query of `req.url` (`?...`, or `''`), whatever request-target form the client sent; never from inside a `#` fragment. */
function rawSearch(req: Request): string {
  const url = req.url.split('#', 1)[0];
  const start = url.indexOf('?');
  return start === -1 ? '' : url.slice(start);
}

export function registerObserveProxy(app: Express): void {
  app.use(PROXY_PREFIX, async (req, res) => {
    const isWrite = req.method !== 'GET';
    if (isWrite && !isAllowedWrite(req)) {
      res.status(405).json({ error: 'The observe proxy only forwards GET reads and allowlisted Studio writes.' });
      return;
    }
    const hasBody = isWrite && req.method !== 'DELETE';
    const body = hasBody ? writeBody(req) : undefined;
    if (hasBody && body === undefined) {
      res.status(413).json({ error: 'Observe write bodies are capped at 1 MiB.' });
      return;
    }
    // Which daemon this proxy points at, so the down state can name the right LOUSHO_OBSERVE value.
    if (req.path === '/__target') {
      res.json({ url: observeTarget() });
      return;
    }
    // req.path is the routed pathname after the mount (an absolute-form line's authority is not in it).
    const upstream = observeUpstreamUrl(req.path, rawSearch(req));
    if (!upstream) {
      res.status(400).json({ error: 'The observe proxy only forwards to the observe daemon it points at.' });
      return;
    }
    let response: Response;
    try {
      response = await fetch(upstream, {
        method: req.method,
        headers: daemonHeaders(hasBody),
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      res
        .status(502)
        .json({ error: 'The observe daemon is unreachable - run `lousho observe start` to collect agent data.' });
      return;
    }
    res.status(response.status);
    if (response.status === 204) {
      res.end();
      return;
    }
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.send(Buffer.from(await response.arrayBuffer()));
  });
}
