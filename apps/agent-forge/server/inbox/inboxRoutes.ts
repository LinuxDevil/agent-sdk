/**
 * Inbox routes (R02a, PLAN §5/§10):
 *
 *   GET  /inbox                      -> InboxItem[] - everything waiting on the user
 *   GET  /inbox/count                -> InboxCount - the same number `inbox.count` pushes
 *   POST /inbox/alerts/:alertId/dismiss -> 204 | 404 { error: 'No alert <id>' }
 *
 * Every handler reads its workspace's `InboxService` from
 * `workspaceOf(req).inbox` - one service per workspace, so a request can
 * never list or dismiss another workspace's items (the alert store is
 * Studio-global; `dismissAlert` re-checks `workspaceId` itself).
 */
import type { Express } from 'express';
import type { InboxCount } from '../../shared/wireTypes';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { workspaceOf } from '../workspace/middleware';

export function registerInboxRoutes(app: Express): void {
  app.get(
    '/inbox',
    asyncRoute(async (req, res) => {
      res.json(await workspaceOf(req).inbox.list());
    })
  );

  app.get(
    '/inbox/count',
    asyncRoute(async (req, res) => {
      const body: InboxCount = { count: await workspaceOf(req).inbox.count() };
      res.json(body);
    })
  );

  app.post(
    '/inbox/alerts/:alertId/dismiss',
    asyncRoute(async (req, res) => {
      const alertId = paramId(req, 'alertId');
      if (!(await workspaceOf(req).inbox.dismissAlert(alertId))) {
        sendError(res, 404, `No alert ${alertId}`);
        return;
      }
      res.status(204).end();
    })
  );
}
