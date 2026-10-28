/**
 * The daemon's route registry. One file per feature area (ingest, traces,
 * insights, agents, scores, status, prompts, hub, datasets, evaluators, queues) exports a `routes` array; this index
 * concatenates them - so a later child spec (prompts, hub, alerts) adds a
 * file here and never touches the daemon's dispatch internals.
 *
 * A route is `{ method, path, handler }` where `path` is a literal template
 * with `:param` segments (`/api/v1/traces/:id`). No framework: the API is a
 * dozen endpoints, so a segment matcher is enough and keeps `node:http` the
 * only server dependency.
 */

import { agentsRoutes } from './agents';
import { datasetsRoutes } from './datasets';
import { evaluatorsRoutes } from './evaluators';
import { hubRoutes } from './hub';
import { ingestRoutes } from './ingest';
import { insightsRoutes } from './insights';
import { promptsRoutes } from './prompts';
import { queuesRoutes } from './queues';
import { scoresRoutes } from './scores';
import { sessionsRoutes } from './sessions';
import { statusRoutes } from './status';
import { tracesRoutes } from './traces';
import type { Route } from './httpKit';

// The shared route contract and helpers live in httpKit.ts; feature files
// import it directly so none of them has to close an import cycle through
// this registry. The pieces the daemon needs stay reachable from here too.
export { BodyTooLargeError, sendJson } from './httpKit';
export type { RouteContext } from './httpKit';

/** Every registered route, feature files in order. Later children append their own import + spread. */
const routes: readonly Route[] = [
  ...statusRoutes,
  ...ingestRoutes,
  ...tracesRoutes,
  ...sessionsRoutes,
  ...insightsRoutes,
  ...agentsRoutes,
  ...scoresRoutes,
  ...promptsRoutes,
  ...hubRoutes,
  ...datasetsRoutes,
  ...evaluatorsRoutes,
  ...queuesRoutes,
];

interface CompiledRoute {
  route: Route;
  segments: string[];
}

const compiled: CompiledRoute[] = routes.map((route) => ({ route, segments: route.path.split('/').filter(Boolean) }));

/** Find the route for `method`/`pathname`; `params` gets the `:name` captures. `undefined` when none matches. */
export function matchRoute(
  method: string,
  pathname: string
): { route: Route; params: Record<string, string> } | undefined {
  const parts = pathname.split('/').filter(Boolean);
  for (const { route, segments } of compiled) {
    if (route.method !== method || segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let match = true;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[i]);
      else if (segment !== parts[i]) {
        match = false;
        break;
      }
    }
    if (match) return { route, params };
  }
  return undefined;
}
