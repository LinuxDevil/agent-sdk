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
 * Only GET is forwarded: Studio is a read surface; the ingest endpoint stays
 * reporter-only. `/observe` sits in app.ts's API_PREFIXES, so it carries the
 * same per-launch token requirement as the rest of the studio API.
 */
import type { Express } from 'express';

const DEFAULT_OBSERVE_URL = 'http://127.0.0.1:7777';
const PROXY_PREFIX = '/observe';
const UPSTREAM_TIMEOUT_MS = 8000;

function observeTarget(): string {
  return (process.env.LOUSHO_OBSERVE_URL ?? DEFAULT_OBSERVE_URL).replace(/\/+$/, '');
}

export function registerObserveProxy(app: Express): void {
  app.use(PROXY_PREFIX, async (req, res) => {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'The observe proxy only forwards GET reads.' });
      return;
    }
    const upstream = `${observeTarget()}${req.originalUrl.slice(PROXY_PREFIX.length)}`;
    let response: Response;
    try {
      response = await fetch(upstream, {
        method: 'GET',
        headers: { accept: 'application/json' },
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
