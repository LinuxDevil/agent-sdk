/**
 * `GET /api/v1/scores` - eval/judge/human score rows, filterable by trace,
 * name, eval name prefix (`eval`, since score names are
 * `<evalName>/<assertionName>`), agent, source and created_at range.
 * The evaluators child emits them through ingest; this is only the read
 * surface the data plane owes Studio.
 *
 * `GET /api/v1/scores?aggregate=eval` returns the eval-history view's
 * aggregate instead of rows: pass-rate, mean value and last-seen time per
 * eval name (see store.scorePassRates).
 */

import { SCORE_SOURCES } from '../envelope';
import { listScores, scorePassRates, type ScoreFilter } from '../store';
import { badRequest, intParam, sendJson, timeParam, type Route } from './httpKit';

export const scoresRoutes: readonly Route[] = [
  {
    method: 'GET',
    path: '/api/v1/scores',
    handle: ({ db, res, query }) => {
      const filter: ScoreFilter = {
        trace_id: query.get('trace_id') ?? undefined,
        name: query.get('name') ?? undefined,
        eval: query.get('eval') ?? undefined,
        agent_id: query.get('agent_id') ?? undefined,
        source: query.get('source') ?? undefined,
        since: timeParam(query, 'since'),
        until: timeParam(query, 'until'),
        limit: intParam(query, 'limit', 200, { min: 1, max: 1000 }),
      };
      if (filter.source !== undefined && !(SCORE_SOURCES as readonly string[]).includes(filter.source)) {
        return badRequest(res, `source must be one of ${SCORE_SOURCES.join(', ')}.`);
      }
      const aggregate = query.get('aggregate');
      if (aggregate === 'eval') {
        return sendJson(res, 200, { evals: scorePassRates(db, filter) });
      }
      if (aggregate !== null) {
        return badRequest(res, "aggregate must be 'eval'.");
      }
      const { scores } = listScores(db, filter);
      sendJson(res, 200, { scores });
    },
  },
];
