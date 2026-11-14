/**
 * Inbox routes (R02a, PLAN §5/§10; W09a adds the `?ws=all` aggregate):
 *
 *   GET  /inbox                      -> InboxItem[] - everything waiting on the user
 *   GET  /inbox?ws=all               -> WorkspaceInboxItem[] - every workspace's items merged
 *   GET  /inbox/count                -> InboxCount - the same number `inbox.count` pushes
 *   GET  /inbox/count?ws=all         -> InboxCount - the Studio-wide total
 *   POST /inbox/alerts/:alertId/dismiss -> 204 | 404 { error: 'No alert <id>' }
 *
 * Every handler reads its workspace's `InboxService` from
 * `workspaceOf(req).inbox` - one service per workspace, so a request can
 * never list or dismiss another workspace's items (the alert store is
 * Studio-global; `dismissAlert` re-checks `workspaceId` itself). The
 * `ALL_WORKSPACES` reads branch to `listAllInbox`/`countAllInbox`
 * (inbox/inboxAggregate.ts) before touching `workspaceOf`.
 */
import type { Express } from 'express';
import type { InboxCount } from '../../shared/wireTypes';
import { ALL_WORKSPACES } from '../../shared/workspace';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { requestedWorkspaceId, workspaceOf } from '../workspace/middleware';
import { countAllInbox, listAllInbox, type InboxAggregateDeps } from './inboxAggregate';

export function registerInboxRoutes(app: Express, aggregate: InboxAggregateDeps): void {
  app.get(
    '/inbox',
    asyncRoute(async (req, res) => {
      if (requestedWorkspaceId(req) === ALL_WORKSPACES) {
        res.json(await listAllInbox(aggregate));
        return;
      }
      res.json(await workspaceOf(req).inbox.list());
    })
  );

  app.get(
    '/inbox/count',
    asyncRoute(async (req, res) => {
      const count =
        requestedWorkspaceId(req) === ALL_WORKSPACES
          ? await countAllInbox(aggregate)
          : await workspaceOf(req).inbox.count();
      const body: InboxCount = { count };
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
