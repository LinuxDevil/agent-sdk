/**
 * Webhook trigger routes (R08a, PLAN §5):
 *
 *   POST /hooks/:agentId/<trigger.path> -> 202 { queued, runKey, started, cancelled }
 *                                        | 202 { skipped: 'filter' }
 *                                        | 400/401/403/404/409/422/429
 *
 * `cancelled` lists the runKeys abort listeners (R03b) stopped for this
 * event, evaluated after signature verification and before the filter.
 * A turned-off agent (`meta.enabled === false`, R09) answers 409
 * `LOUSHO_AGENT_DISABLED` right after auth - no event processing beyond it.
 *
 * The request path after `/hooks/:agentId/` must equal a webhook
 * trigger's `path` (the canvas default is `/hooks/<triggerId>`, so the
 * full URL is `/hooks/<agentId>/hooks/<triggerId>`). Raw bytes are read
 * by the `express.raw` mount app.ts puts on `/hooks` BEFORE the JSON
 * parser, so HMAC verification sees exactly what the sender signed.
 *
 * Auth order: a trigger with `secret` verifies HMAC (SDK
 * `checkWebhookAuth`, sha256 by default); a trigger WITHOUT one accepts
 * only loopback `Host`s - it is a local-testing affordance, not a public
 * endpoint. The global Host/Origin + token gate skips `/hooks/**`
 * entirely (needsToken + the access middleware in app.ts); this route
 * applies its own host rule instead.
 *
 * Per-workspace seam: the host and repo come from `workspaceOf(req)` -
 * `?ws=<id>` picks the workspace, so webhook URLs carry it in multi-
 * workspace mode. Secrets are Studio-global (`resolveSecret` dep).
 */
import type { Express, Request, Response } from 'express';
import { evaluateSafeExpression } from 'lousho/flows';
import { resolveSecretRef } from 'lousho';
import type { TriggerSpec } from 'lousho/spec';
import { checkWebhookAuth } from 'lousho/triggers';

import { isLoopbackHost } from '../auth';
import { asyncRoute, sendError } from '../http/routeUtils';
import { workspaceOf } from '../workspace/middleware';
import { applyAbortListeners } from './abortListeners';
import { renderTemplate } from './template';

type WebhookTrigger = Extract<TriggerSpec, { type: 'webhook' }>;

export interface WebhookRouteDeps {
  /** Named-secret lookup (`SecretsStore.getSecret`); `{ env }` refs read the process env themselves. */
  resolveSecret: (name: string) => string | undefined;
}

/** The `Host` header's hostname is loopback - the unsigned-trigger rule. */
function loopbackCall(req: Request): boolean {
  const host = req.headers.host;
  return isLoopbackHost(Array.isArray(host) ? host[0] : host);
}

/** `req.params.splat` as the path text after `/hooks/:agentId/`, leading `/` restored. */
function triggerPath(req: Request): string {
  const splat = req.params.splat;
  const rest = Array.isArray(splat) ? splat.join('/') : String(splat ?? '');
  return `/${rest}`;
}

/** The webhook trigger on this agent whose `path` equals the request's - first match wins. */
function matchingTrigger(triggers: TriggerSpec[], path: string): WebhookTrigger | undefined {
  return triggers.find((t): t is WebhookTrigger => t.type === 'webhook' && t.path === path);
}

/** Parses the raw body as JSON; anything else becomes `{ body: <text> }`. */
function eventOf(rawBody: Buffer): unknown {
  const text = rawBody.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return { body: text };
  }
}

/** Verifies the trigger's secret (when it has one); replies and returns false on failure. */
async function checkSignature(
  req: Request,
  res: Response,
  trigger: WebhookTrigger,
  rawBody: Buffer,
  resolveSecret: WebhookRouteDeps['resolveSecret']
): Promise<boolean> {
  if (trigger.secret === undefined) {
    if (loopbackCall(req)) return true;
    sendError(res, 403, 'This webhook has no secret, so it only accepts local calls.');
    return false;
  }
  let secret: string;
  try {
    secret = await resolveSecretRef(trigger.secret, { resolveSecret }, `triggers.${trigger.id}.secret`);
  } catch {
    sendError(res, 503, `Webhook secret for trigger '${trigger.id}' is not configured`, 'LOUSHO_SECRET_MISSING');
    return false;
  }
  const failure = await checkWebhookAuth({ type: 'hmac', secret }, req, rawBody);
  if (failure !== undefined) {
    sendError(res, 401, 'Invalid webhook signature');
    return false;
  }
  return true;
}

export function registerWebhookRoutes(app: Express, deps: WebhookRouteDeps): void {
  app.post(
    '/hooks/:agentId/*splat',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      const agentId = String(req.params.agentId);
      const trigger = matchingTrigger(ws.triggers.triggersOf(agentId), triggerPath(req));
      if (trigger === undefined) {
        sendError(res, 404, 'No webhook here');
        return;
      }

      // express.raw mounted this path in app.ts, so req.body is the Buffer
      // the sender signed - never the re-serialized JSON.
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!(await checkSignature(req, res, trigger, rawBody, deps.resolveSecret))) return;

      // R09: a turned-off agent does no event processing beyond auth -
      // abort listeners, filter and dispatch all wait for it to be on.
      if (!ws.triggers.isEnabled(agentId)) {
        sendError(res, 409, 'Agent is turned off', 'LOUSHO_AGENT_DISABLED');
        return;
      }

      const event = eventOf(rawBody);

      // Abort listeners run after signature verification but before the
      // filter and the dispatch (R03b): a `when: true` listener cancels
      // matching queued/running runs of the trigger it watches. The run
      // this event is about to queue does not exist yet, so it can never
      // cancel itself.
      const spec = await ws.repo.readSpec(agentId);
      const cancelled =
        spec === undefined
          ? []
          : applyAbortListeners({
              spec,
              agentId,
              triggerId: trigger.id,
              event,
              host: ws.triggers,
              log: (id, message, level) => ws.triggers.log(id, message, level),
            }).flatMap((outcome) => outcome.cancelled.map((c) => c.runKey));

      if (trigger.filter !== undefined) {
        const keep = evaluateSafeExpression(trigger.filter, { event });
        if (keep !== true) {
          res.status(202).json({ skipped: 'filter' });
          return;
        }
      }

      const input = renderTemplate(trigger.promptTemplate ?? '', { event }).trim();
      if (input === '') {
        sendError(res, 422, 'The prompt template rendered empty.');
        return;
      }

      const result = ws.triggers.dispatch({ agentId, triggerId: trigger.id, input, event });
      if (!result.ok) {
        if (result.reason === 'queue_full') {
          sendError(res, 429, 'Too many queued runs for this agent', 'LOUSHO_TRIGGER_QUEUE_FULL');
          return;
        }
        if (result.reason === 'disabled') {
          sendError(res, 409, 'Agent is turned off', 'LOUSHO_AGENT_DISABLED');
          return;
        }
        sendError(res, 404, `No webhook trigger '${trigger.id}' for agent '${agentId}'`);
        return;
      }
      res.status(202).json({ queued: true, runKey: result.runKey, started: result.started, cancelled });
    })
  );
}
