/**
 * The Studio thread reads. `GET /api/v1/sessions` lists conversation
 * threads (newest first) with their run totals; `GET /api/v1/sessions/:id`
 * returns one thread plus its traces in conversation order (start ascending).
 */

import { getSession, listSessions, listTraces, type SessionFilter } from '../store';
import { intParam, sendJson, timeParam, type Route } from './httpKit';

const LIST_LIMIT = { min: 1, max: 500 };
/** The most traces `GET /api/v1/sessions/:id` returns; a longer thread is cut at the cap. */
const SESSION_TRACES_CAP = 500;

export const sessionsRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: '/api/v1/sessions',
    handle: ({ db, res, query }) => {
      const filter: SessionFilter = {
        agent_id: query.get('agent_id') ?? undefined,
        status: query.get('status') ?? undefined,
        from: timeParam(query, 'from'),
        to: timeParam(query, 'to'),
        limit: intParam(query, 'limit', 50, LIST_LIMIT),
        offset: intParam(query, 'offset', 0, { min: 0, max: Number.MAX_SAFE_INTEGER }),
      };
      const { sessions, total } = listSessions(db, filter);
      sendJson(res, 200, { sessions, total, limit: filter.limit, offset: filter.offset });
    },
  },
  {
    method: 'GET',
    path: '/api/v1/sessions/:id',
    handle: ({ db, res, params }) => {
      const session = getSession(db, params.id);
      if (!session) return sendJson(res, 404, { error: `No session '${params.id}'.`, code: 'LOUSHO_REQUEST_INVALID' });
      const { traces } = listTraces(db, {
        session_id: params.id,
        sort: 'start',
        order: 'asc',
        limit: SESSION_TRACES_CAP,
        offset: 0,
      });
      sendJson(res, 200, { session, traces });
    },
  },
];
