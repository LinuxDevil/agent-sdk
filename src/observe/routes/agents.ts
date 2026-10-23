/**
 * `GET /api/v1/agents` - the fleet registry rows with Monitoring columns:
 * sweep-owned `status` (heartbeat freshness: healthy/stale/down, or 'stopped'
 * from a graceful `agent.deregister`) plus `runs_today`/`error_rate_today`
 * from the day rollups - the same UTC bucket ingest recomputes, so this adds
 * no scan of the observations table.
 */

import type { SqlDatabase } from '../../storage/sqlite/driver';
import { listAgents } from '../store';
import { sendJson, type Route } from './index';

const DAY_MS = 86_400_000;

/** Per-agent run/error counts of today's UTC day rollup bucket. */
function todayStats(db: SqlDatabase, now: number): Map<string, { runs: number; errors: number }> {
  const dayStart = now - (now % DAY_MS);
  const stats = new Map<string, { runs: number; errors: number }>();
  for (const row of db
    .prepare("SELECT agent_id, metric, value FROM rollups WHERE granularity = 'day' AND bucket_start = ?")
    .all(dayStart)) {
    const entry = stats.get(String(row.agent_id)) ?? { runs: 0, errors: 0 };
    if (row.metric === 'runs') entry.runs += Number(row.value);
    else if (row.metric === 'errors') entry.errors += Number(row.value);
    stats.set(String(row.agent_id), entry);
  }
  return stats;
}

export const agentsRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: '/api/v1/agents',
    handle: ({ db, res, query }) => {
      const now = Date.now();
      let agents = listAgents(db, now);
      const project = query.get('project');
      if (project !== null) agents = agents.filter((agent) => agent.project === project);
      const stats = todayStats(db, now);
      sendJson(res, 200, {
        agents: agents.map((agent) => {
          const today = stats.get(agent.agent_id) ?? { runs: 0, errors: 0 };
          return {
            ...agent,
            runs_today: today.runs,
            error_rate_today: today.runs > 0 ? today.errors / today.runs : 0,
          };
        }),
      });
    },
  },
];
