/**
 * Pass routes - Studio-global like the settings routes (the spend log is
 * one `studioPaths().spend` file shared by every workspace; the pass
 * settings live in the shared `settings.json`).
 *
 *   GET /settings/passes/spend?month=YYYY-MM -> PassSpendSummary
 *   GET /settings/passes                  -> PassSettings
 *   PUT /settings/passes                  -> PassSettings (body: PassSettingsPatch)
 */
import type { Express } from 'express';
import type { PassSettingsPatch } from '../../shared/wireTypes';
import { asyncRoute, sendError } from '../http/routeUtils';
import type { SettingsStore } from '../settingsStore';
import { summarizeSpend, type SpendLog } from './spendLog';

const MONTH_RE = /^\d{4}-\d{2}$/;

/** The current UTC month as `YYYY-MM` - the spend route's default window. */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * A `PUT /settings/passes` body as a {@link PassSettingsPatch}: `undefined`
 * for a non-object body (the route 400s it); field validation is
 * `SettingsStore.setPasses`'s, whose thrown message becomes the 400.
 */
function parsePassPatch(body: unknown): PassSettingsPatch | undefined {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return undefined;
  return body as PassSettingsPatch;
}

export function registerPassRoutes(app: Express, deps: { spendLog: SpendLog; settings: SettingsStore }): void {
  app.get(
    '/settings/passes/spend',
    asyncRoute(async (req, res) => {
      const raw = req.query.month;
      const month = typeof raw === 'string' && raw !== '' ? raw : currentMonth();
      if (!MONTH_RE.test(month)) {
        res.status(400).json({ error: 'month must look like 2026-10' });
        return;
      }
      res.json(summarizeSpend(await deps.spendLog.read(month), month));
    })
  );

  app.get('/settings/passes', (_req, res) => {
    res.json(deps.settings.passes());
  });

  app.put('/settings/passes', (req, res) => {
    const patch = parsePassPatch(req.body);
    if (patch === undefined) {
      sendError(res, 400, 'body must be an object.');
      return;
    }
    try {
      res.json(deps.settings.setPasses(patch));
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
    }
  });
}
