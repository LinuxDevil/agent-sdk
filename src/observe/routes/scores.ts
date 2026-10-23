/**
 * `GET /api/v1/scores` - eval/judge/human score rows, filterable by trace,
 * name and agent. The evaluators child emits them through ingest; this is
 * only the read surface the data plane owes Studio.
 */

import { listScores } from '../store';
import { intParam, sendJson, type Route } from './index';

export const scoresRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: '/api/v1/scores',
    handle: ({ db, res, query }) => {
      const { scores } = listScores(db, {
        trace_id: query.get('trace_id') ?? undefined,
        name: query.get('name') ?? undefined,
        agent_id: query.get('agent_id') ?? undefined,
        limit: intParam(query, 'limit', 200, { min: 1, max: 1000 }),
      });
      sendJson(res, 200, { scores });
    },
  },
];
