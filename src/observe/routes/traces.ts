/**
 * The Studio trace reads. `GET /api/v1/traces` is the paginated, filterable
 * trace list (one row per `trace_id`, status from the root observation);
 * `GET /api/v1/traces/:id` returns the trace's whole observation set ordered
 * by start - flat rows the panel nests by `parent_obs_id` - plus its scores.
 */

import { listTraces, traceDetail, TRACE_SORTS, type TraceFilter, type TraceSort } from '../store';
import { badRequest, intParam, sendJson, timeParam, type Route } from './httpKit';

const LIST_LIMIT = { min: 1, max: 500 };
const ORDERS = ['asc', 'desc'] as const;

/** `sort`/`order`/`min_duration_ms`, or the message for the 400 a bad value earns. */
function listShape(query: URLSearchParams): Pick<TraceFilter, 'sort' | 'order' | 'min_duration_ms'> | string {
  const sort = query.get('sort') ?? undefined;
  if (sort !== undefined && !(TRACE_SORTS as readonly string[]).includes(sort)) {
    return `Invalid sort '${sort}': expected one of ${TRACE_SORTS.join(', ')}.`;
  }
  const order = query.get('order') ?? undefined;
  if (order !== undefined && !(ORDERS as readonly string[]).includes(order)) {
    return `Invalid order '${order}': expected asc or desc.`;
  }
  const rawDuration = query.get('min_duration_ms');
  const min_duration_ms = rawDuration === null ? undefined : Number(rawDuration);
  if (min_duration_ms !== undefined && (rawDuration?.trim() === '' || !Number.isFinite(min_duration_ms))) {
    return `Invalid min_duration_ms '${rawDuration}': expected a number of milliseconds.`;
  }
  return { sort: sort as TraceSort | undefined, order: order as 'asc' | 'desc' | undefined, min_duration_ms };
}

export const tracesRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: '/api/v1/traces',
    handle: ({ db, res, query }) => {
      const shape = listShape(query);
      if (typeof shape === 'string') return badRequest(res, shape);
      const filter: TraceFilter = {
        agent_id: query.get('agent_id') ?? undefined,
        project: query.get('project') ?? undefined,
        status: query.get('status') ?? undefined,
        session_id: query.get('session_id') ?? undefined,
        since: timeParam(query, 'since'),
        until: timeParam(query, 'until'),
        from: timeParam(query, 'from'),
        to: timeParam(query, 'to'),
        q: query.get('q') ?? undefined,
        model: query.get('model') ?? undefined,
        ...shape,
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
