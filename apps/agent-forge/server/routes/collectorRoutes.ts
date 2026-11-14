/**
 * `GET/PUT /settings/collector` - the Settings → Collector card's read and
 * write path (collector.ts holds the semantics; this maps them to HTTP).
 * Studio-global like the other `/settings/*` routes: the collector is one
 * per Studio process, not per workspace.
 */
import type { Express } from 'express';
import type { CollectorUpdate } from '../../shared/wireTypes';
import { asyncRoute, sendError } from '../http/routeUtils';
import { CollectorLockedError, CollectorUrlError, type CollectorManager } from '../collector';

const COLLECTOR_URL_INVALID = 'Enter an http or https URL without a path, or leave it empty to use this machine.';

/** `true` when `body` is a CollectorUpdate shape: `url` string|null, `token` string|null|undefined. */
function isCollectorUpdate(body: unknown): body is CollectorUpdate {
  if (typeof body !== 'object' || body === null) return false;
  const { url, token } = body as { url?: unknown; token?: unknown };
  return (typeof url === 'string' || url === null) && (token === undefined || token === null || typeof token === 'string');
}

export function registerCollectorRoutes(app: Express, collector: CollectorManager): void {
  app.get(
    '/settings/collector',
    asyncRoute(async (req, res) => {
      res.json(req.query.probe === '1' ? await collector.probe() : collector.status());
    })
  );

  app.put(
    '/settings/collector',
    asyncRoute(async (req, res) => {
      const body: unknown = req.body;
      if (!isCollectorUpdate(body)) {
        sendError(res, 400, COLLECTOR_URL_INVALID, 'LOUSHO_COLLECTOR_URL_INVALID');
        return;
      }
      try {
        res.json(await collector.reconfigure(body));
      } catch (error) {
        if (error instanceof CollectorLockedError) {
          sendError(res, 409, error.message, 'LOUSHO_COLLECTOR_ENV_LOCKED');
          return;
        }
        if (error instanceof CollectorUrlError) {
          sendError(res, 400, error.message, 'LOUSHO_COLLECTOR_URL_INVALID');
          return;
        }
        throw error;
      }
    })
  );
}
