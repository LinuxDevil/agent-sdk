/**
 * Rating routes (R04a, PLAN §5/§10):
 *
 *   POST /agents/:id/rating                 -> 204 | 400 | 404 | 502
 *   POST /agents/:id/rating/:alertId/dataset -> 200 { dataset, exampleId } | 404 | 422 | 502
 *
 * The first records a human `rating` score (1-5) on the run's trace in the
 * observe daemon; a rating of {@link LOW_RATING_MAX} or less also raises a
 * `low_rating` inbox alert. The second copies that trace into the agent's
 * `<agentId>-regressions` dataset so a bad run becomes an eval case.
 *
 * Daemon calls go straight to `observeTarget()` with `daemonHeaders()` -
 * the `/observe` proxy's write allowlist is irrelevant here (the ticket's
 * gotcha). Every route sits under `/agents`, so the launch token gate
 * already applies; the workspace comes from `workspaceOf(req)` (the alert
 * carries its `ref.id`, and its inbox is what `refresh()` recounts).
 */
import type { Express, Response } from 'express';
import { LOW_RATING_MAX, RATING_LABELS, type RatingRequest } from '../shared/wireTypes';
import { daemonHeaders, observeTarget } from './observeProxy';
import { asyncRoute, paramId, sendError } from './http/routeUtils';
import { workspaceOf } from './workspace/middleware';
import type { AlertStore } from './inbox/alertStore';

const DAEMON_TIMEOUT_MS = 8000;
/** Dataset names cap at 200 chars (`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`); cut the id part, never the suffix. */
const DATASET_SUFFIX = '-regressions';
const DATASET_NAME_MAX = 200;

/** `<agentId>-regressions`, trimmed to the daemon's 200-char dataset-name limit. */
export function regressionsDatasetName(agentId: string): string {
  const id = agentId.slice(0, DATASET_NAME_MAX - DATASET_SUFFIX.length);
  return `${id}${DATASET_SUFFIX}`;
}

/**
 * A JSON POST to the observe daemon; the `Response`, or `undefined` when it
 * is unreachable (the route answers 502 `LOUSHO_OBSERVE_DOWN`).
 */
async function daemonPost(
  fetchFn: typeof fetch,
  path: string,
  body: unknown
): Promise<globalThis.Response | undefined> {
  try {
    return await fetchFn(`${observeTarget()}${path}`, {
      method: 'POST',
      headers: daemonHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DAEMON_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
}

/** The 502 every handler shares for an unreachable daemon. */
function observeDown(res: Response): void {
  sendError(res, 502, 'Observe daemon is not running', 'LOUSHO_OBSERVE_DOWN');
}

/**
 * The request body as a {@link RatingRequest}: `undefined` when it fails the
 * hand-rolled checks (traceId non-empty <= 200, integer value 1-5, comment
 * string <= 2000 when present) - the route 400s it.
 */
function parseRatingRequest(body: unknown): RatingRequest | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const { traceId, value, comment } = body as Record<string, unknown>;
  if (typeof traceId !== 'string' || traceId === '' || traceId.length > 200) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) return undefined;
  if (comment !== undefined && (typeof comment !== 'string' || comment.length > 2000)) return undefined;
  return { traceId, value: value as RatingRequest['value'], ...(comment === undefined ? {} : { comment }) };
}

export function registerRatingRoutes(app: Express, deps: { alerts: AlertStore; fetch?: typeof fetch }): void {
  const fetchFn = deps.fetch ?? fetch;

  app.post(
    '/agents/:id/rating',
    asyncRoute(async (req, res) => {
      const rating = parseRatingRequest(req.body);
      if (rating === undefined) {
        sendError(res, 400, 'Body must be { traceId: string (1-200), value: 1-5, comment?: string (<= 2000) }');
        return;
      }
      const posted = await daemonPost(fetchFn, '/api/v1/scores', {
        trace_id: rating.traceId,
        name: 'rating',
        value: rating.value,
        ...(rating.comment === undefined ? {} : { comment: rating.comment }),
      });
      if (posted === undefined) return observeDown(res);
      if (posted.status === 404) {
        sendError(res, 404, `No trace '${rating.traceId}'`);
        return;
      }
      if (!posted.ok) {
        observeDown(res);
        return;
      }
      if (rating.value <= LOW_RATING_MAX) {
        const agentId = paramId(req);
        const ws = workspaceOf(req);
        await deps.alerts.add({
          kind: 'low_rating',
          agentId,
          workspaceId: ws.ref.id,
          title: `Run rated ${rating.value} (${RATING_LABELS[rating.value - 1]})`,
          detail: rating.comment?.slice(0, 280) ?? null,
          payload: { traceId: rating.traceId, value: rating.value, comment: rating.comment ?? null },
        });
        await ws.inbox.refresh();
      }
      res.status(204).end();
    })
  );

  app.post(
    '/agents/:id/rating/:alertId/dataset',
    asyncRoute(async (req, res) => {
      const agentId = paramId(req);
      const alertId = paramId(req, 'alertId');
      const alert = (await deps.alerts.list()).find((a) => a.id === alertId);
      // Only this agent's own live low-rating alert can seed the dataset -
      // the trace id comes from its payload, never the request.
      if (
        alert === undefined ||
        alert.kind !== 'low_rating' ||
        alert.agentId !== agentId ||
        alert.workspaceId !== workspaceOf(req).ref.id ||
        alert.dismissedAt !== null ||
        typeof alert.payload.traceId !== 'string'
      ) {
        sendError(res, 404, `No alert ${alertId}`);
        return;
      }
      const traceId = alert.payload.traceId;
      const dataset = regressionsDatasetName(agentId);
      // Create-or-reuse: 201 and 409 both mean the dataset exists now.
      const created = await daemonPost(fetchFn, '/api/v1/datasets', {
        name: dataset,
        description: `Runs of ${agentId} rated ${LOW_RATING_MAX} or lower.`,
      });
      if (created === undefined) return observeDown(res);
      if (!created.ok && created.status !== 409) {
        observeDown(res);
        return;
      }
      const example = await daemonPost(
        fetchFn,
        `/api/v1/datasets/${encodeURIComponent(dataset)}/examples`,
        { from_trace_id: traceId }
      );
      if (example === undefined) return observeDown(res);
      if (example.status === 404) {
        sendError(res, 404, `No trace '${traceId}'`);
        return;
      }
      if (example.status === 400) {
        const body = (await example.json().catch(() => undefined)) as { error?: string } | undefined;
        if (body?.error?.includes('no captured input')) {
          sendError(res, 422, body.error, 'LOUSHO_TRACE_NO_INPUT');
          return;
        }
        observeDown(res);
        return;
      }
      if (!example.ok) {
        observeDown(res);
        return;
      }
      const added = (await example.json().catch(() => undefined)) as { example?: { example_id?: string } } | undefined;
      res.json({ dataset, exampleId: added?.example?.example_id ?? '' });
    })
  );
}
