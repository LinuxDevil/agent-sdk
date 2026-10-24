/**
 * `GET /api/v1/insights` - per-agent aggregate cards plus the rollup time
 * series the Insights charts draw. Aggregates come from `rollups` (runs/day,
 * cost, error rate, tokens); latency percentiles are the sanctioned
 * drilldown on `observations`. Window: `days` (default 7) or explicit
 * `since`/`until` epoch-ms.
 */

import { insightsAgents, rollupSeries, type RollupGranularity } from '../store';
import { intParam, sendJson, timeParam, type Route } from './httpKit';

const DAY_MS = 86_400_000;

export const insightsRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: '/api/v1/insights',
    handle: ({ db, res, query }) => {
      const until = timeParam(query, 'until') ?? Date.now();
      const days = intParam(query, 'days', 7, { min: 1, max: 365 });
      const since = timeParam(query, 'since') ?? until - days * DAY_MS;
      const agentId = query.get('agent_id') ?? undefined;
      const granularity = (query.get('granularity') ?? 'hour') as RollupGranularity;
      const agents = insightsAgents(db, { since, until }).filter((a) => agentId === undefined || a.agent_id === agentId);
      const series = rollupSeries(db, { granularity: granularity === 'day' ? 'day' : 'hour', agent_id: agentId, since, until });
      sendJson(res, 200, { window: { since, until }, agents, series });
    },
  },
];
