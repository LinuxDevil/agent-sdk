/**
 * Pass spend routes - Studio-global like the settings routes (the spend
 * log is one `studioPaths().spend` file shared by every workspace).
 *
 *   GET /settings/passes/spend?month=YYYY-MM -> PassSpendSummary
 */
import type { Express } from 'express';
import { asyncRoute } from '../http/routeUtils';
import { summarizeSpend, type SpendLog } from './spendLog';

const MONTH_RE = /^\d{4}-\d{2}$/;

/** The current UTC month as `YYYY-MM` - the spend route's default window. */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function registerPassRoutes(app: Express, deps: { spendLog: SpendLog }): void {
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
}
