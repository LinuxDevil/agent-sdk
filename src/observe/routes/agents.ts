/**
 * `GET /api/v1/agents` - the fleet registry rows with read-time freshness
 * (`healthy`/`stale`/`down` derived from `last_heartbeat`; `stopped` survives
 * from a graceful `agent.deregister`). The monitoring child's sweep will own
 * status rewrites later; the read shape stays.
 */

import { listAgents } from '../store';
import { sendJson, type Route } from './index';

export const agentsRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: '/api/v1/agents',
    handle: ({ db, res, query }) => {
      let agents = listAgents(db);
      const project = query.get('project');
      if (project !== null) agents = agents.filter((agent) => agent.project === project);
      sendJson(res, 200, { agents });
    },
  },
];
