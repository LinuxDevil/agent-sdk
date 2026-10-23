/**
 * The Studio trace reads. `GET /api/v1/traces` is the paginated, filterable
 * trace list (one row per `trace_id`, status from the root observation);
 * `GET /api/v1/traces/:id` returns the trace's whole observation set ordered
 * by start - flat rows the panel nests by `parent_obs_id` - plus its scores.
 */

import { listTraces, traceDetail, type TraceFilter } from '../store';
import { intParam, sendJson, timeParam, type Route } from './index';

const LIST_LIMIT = { min: 1, max: 500 };

export const tracesRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: '/api/v1/traces',
    handle: ({ db, res, query }) => {
      const filter: TraceFilter = {
        agent_id: query.get('agent_id') ?? undefined,
        project: query.get('project') ?? undefined,
        status: query.get('status') ?? undefined,
        session_id: query.get('session_id') ?? undefined,
        since: timeParam(query, 'since'),
        until: timeParam(query, 'until'),
        limit: intParam(query, 'limit', 50, LIST_LIMIT),
        offset: intParam(query, 'offset', 0, { min: 0, max: Number.MAX_SAFE_INTEGER }),
      };
      const { traces, total } = listTraces(db, filter);
      sendJson(res, 200, { traces, total, limit: filter.limit, offset: filter.offset });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/traces/:id',
    handle: ({ db, res, params }) => {
      const detail = traceDetail(db, params.id);
      if (!detail) return sendJson(res, 404, { error: `No trace '${params.id}'.`, code: 'LOUSHO_REQUEST_INVALID' });
      sendJson(res, 200, detail);
    },
  },
];
