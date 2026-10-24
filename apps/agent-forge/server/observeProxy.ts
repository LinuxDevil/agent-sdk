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
 * GET is forwarded for every path; writes only for the explicit
 * {@link WRITE_ROUTES} allowlist (today: human feedback scores), with the
 * JSON body app.ts's `express.json` (2 MB cap) already parsed. Everything
 * else non-GET - the ingest endpoint above all - answers 405 and stays
 * reporter-only. `/observe` sits in app.ts's API_PREFIXES, so it carries the
 * same per-launch token requirement as the rest of the studio API.
 */
import type { Express } from 'express';

const DEFAULT_OBSERVE_URL = 'http://127.0.0.1:7777';
const PROXY_PREFIX = '/observe';
const UPSTREAM_TIMEOUT_MS = 8000;

/** The daemon writes Studio may forward (method + path below `/observe`). Add one entry per new write surface. */
const WRITE_ROUTES: { method: 'POST' | 'PUT'; path: RegExp }[] = [{ method: 'POST', path: /^\/api\/v1\/scores$/ }];

function isAllowedWrite(method: string, path: string): boolean {
  return WRITE_ROUTES.some((route) => route.method === method && route.path.test(path));
}

/** The daemon the Studio reads (and playground runs report to): `LOUSHO_OBSERVE_URL`, default loopback :7777. */
export function observeTarget(): string {
  return (process.env.LOUSHO_OBSERVE_URL ?? DEFAULT_OBSERVE_URL).replace(/\/+$/, '');
}

export function registerObserveProxy(app: Express): void {
  app.use(PROXY_PREFIX, async (req, res) => {
    const write = req.method !== 'GET';
    if (write && !isAllowedWrite(req.method, req.path)) {
      res.status(405).json({ error: 'The observe proxy only forwards GET reads and allowlisted writes.' });
      return;
    }
    // Which daemon this proxy points at, so the down state can name the right LOUSHO_OBSERVE value.
    if (req.path === '/__target') {
      res.json({ url: observeTarget() });
      return;
    }
    const upstream = `${observeTarget()}${req.originalUrl.slice(PROXY_PREFIX.length)}`;
    let response: Response;
    try {
      response = await fetch(upstream, {
        method: req.method,
        headers: write ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' },
        body: write ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      res
        .status(502)
        .json({ error: 'The observe daemon is unreachable - run `lousho observe start` to collect agent data.' });
      return;
    }
    res.status(response.status);
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.send(Buffer.from(await response.arrayBuffer()));
  });
}
