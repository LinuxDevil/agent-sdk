/**
 * Suggestion routes - `GET /agents/:id/suggestions`,
 * `POST /agents/:id/suggestions/from-trace` and
 * `POST /agents/:id/suggestions/:sid/apply` · `/dismiss` (Contract C's
 * suggestion rows; the Suggestions tab's API).
 *
 * The `suggestions/` folder holds two record kinds (see
 * storage/suggestionStore.ts); only `prompt_edit` records are
 * suggestions - `GET` filters portability analyses out and settling
 * routes answer them 404.
 *
 * `from-trace` reserves a suggestion id and answers 202 while the
 * `prompt_suggestion` pass (passes/promptSuggestion.ts) fetches the
 * trace's friction digest and asks the pass model for one anchored
 * instructions edit; the record appears when the pass finishes.
 *
 * Apply is compare-and-swap on the instructions: passes/promptSuggestion.ts's
 * `applyPromptSuggestion` owns the checks - inside the per-agent lock it
 * reconciles an external edit (a hand-edited yaml is baselined first),
 * then lands the anchored `oldText` → `newText` rewrite only when the
 * instructions still hash to `expectedPromptHash` AND `oldText` occurs
 * exactly once - anything else marks the record `conflict`. A landed
 * apply writes one `kind: 'update', source: 'suggestion'` version before
 * the record goes `applied`.
 *
 * Every handler reads `repo`, `versions` and `suggestions` off
 * `workspaceOf(req)` (the workspace seam); the stores stay lock-free and
 * the writers serialize through `withAgentLock(id)` inside
 * `applyPromptSuggestion`. The Studio-global secrets/settings the pass
 * model needs arrive as registration deps, like the portability routes.
 */
import type { Express, Request, Response } from 'express';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { ChainInvalidError } from '../triggers/chainTriggers';
import { withAgentLock } from '../storage/atomic';
import { SUGGESTION_ID_RE } from '../storage/suggestionStore';
import type { SecretsStore } from '../secretsStore';
import type { SettingsStore } from '../settingsStore';
import { workspaceOf } from '../workspace/middleware';
import type { WorkspaceContext } from '../workspace/context';
import {
  applyPromptSuggestion,
  enqueuePromptSuggestion,
  PromptSuggestionError,
  type PromptSuggestionDeps,
} from '../passes/promptSuggestion';
import type { PromptSuggestion } from '../../shared/wireTypes';

/** The exact 409 message a settled suggestion gets (Contract C). */
const NOT_OPEN_MESSAGE = 'This suggestion was already applied or dismissed.';

/** The Studio-global stores the suggestion routes need (per-workspace stores come from `workspaceOf(req)`). */
export interface SuggestionRouteDeps {
  secretsStore: SecretsStore;
  settings: SettingsStore;
}

/** The pass deps one request's workspace context plus the Studio-global stores make. */
function passDepsFor(ws: WorkspaceContext, globals: SuggestionRouteDeps): PromptSuggestionDeps {
  return {
    passRunner: ws.passes,
    repo: ws.repo,
    versions: ws.versions,
    suggestions: ws.suggestions,
    events: ws.events,
    inbox: ws.inbox,
    secretsStore: globals.secretsStore,
    settings: globals.settings,
    workspaceId: ws.ref.id,
  };
}

/**
 * The `:sid` param when it can name a suggestion record, `undefined`
 * once the 400 was sent. Ids become file names, so anything failing
 * {@link SUGGESTION_ID_RE} is rejected before a path is ever built.
 */
function paramSid(req: Request, res: Response): string | undefined {
  const sid = paramId(req, 'sid');
  if (!SUGGESTION_ID_RE.test(sid)) {
    sendError(res, 400, 'Invalid suggestion id', 'LOUSHO_SUGGESTION_ID_INVALID');
    return undefined;
  }
  return sid;
}

/**
 * The open `prompt_edit` record `sid` names for the dismiss route,
 * `undefined` once the 404/409 was sent: a missing record (or a
 * portability analysis, which is not a suggestion) is a 404, a settled
 * one a 409.
 */
async function openSuggestion(
  ws: WorkspaceContext,
  res: Response,
  id: string,
  sid: string
): Promise<PromptSuggestion | undefined> {
  const suggestion = await ws.suggestions.get(id, sid);
  if (suggestion === undefined || suggestion.kind !== 'prompt_edit') {
    sendError(res, 404, `No suggestion '${sid}' for agent '${id}'`, 'LOUSHO_SUGGESTION_NOT_FOUND');
    return undefined;
  }
  if (suggestion.status !== 'open') {
    sendError(res, 409, NOT_OPEN_MESSAGE, 'LOUSHO_SUGGESTION_NOT_OPEN');
    return undefined;
  }
  return suggestion;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Registers the suggestion routes. Per-workspace stores come from
 * `workspaceOf(req)`; `globals` carries the Studio-global secrets and
 * settings stores the prompt-suggestion pass model resolves through.
 */
export function registerSuggestionRoutes(app: Express, globals: SuggestionRouteDeps): void {
  // The agent's prompt suggestions: open ones first, then newest
  // `createdAt` first. Portability analyses share the folder but are not
  // suggestions and never appear.
  app.get(
    '/agents/:id/suggestions',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      const id = paramId(req);
      if (!ws.repo.exists(id)) {
        sendError(res, 404, `No saved agent '${id}'`, 'LOUSHO_AGENT_NOT_FOUND');
        return;
      }
      const items = (await ws.suggestions.list(id)).filter(
        (item): item is PromptSuggestion => item.kind === 'prompt_edit'
      );
      items.sort(
        (a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.createdAt.localeCompare(a.createdAt)
      );
      res.json(items);
    })
  );

  // From-trace: reserve the id, answer 202, let the pass fetch the
  // trace's friction digest and ask the model for one anchored edit.
  // The record appears under `suggestions/<id>.json` when it finishes.
  app.post(
    '/agents/:id/suggestions/from-trace',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      const id = paramId(req);
      const body = req.body;
      const traceId = isObject(body) && typeof body.traceId === 'string' ? body.traceId : undefined;
      if (traceId === undefined || traceId === '') {
        sendError(res, 400, "'traceId' must be a non-empty string", 'LOUSHO_BODY_INVALID');
        return;
      }
      try {
        const { suggestionId } = await enqueuePromptSuggestion(passDepsFor(ws, globals), id, traceId);
        res.status(202).json({ suggestionId });
      } catch (error) {
        if (error instanceof PromptSuggestionError) {
          sendError(res, error.status, error.message, error.code);
          return;
        }
        throw error;
      }
    })
  );

  // Apply: the CAS-guarded instructions edit lives in
  // passes/promptSuggestion.ts; the route maps its outcome onto the
  // response (201 with the written version on success).
  app.post(
    '/agents/:id/suggestions/:sid/apply',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      const id = paramId(req);
      const sid = paramSid(req, res);
      if (sid === undefined) return;
      let result: Awaited<ReturnType<typeof applyPromptSuggestion>>;
      try {
        result = await applyPromptSuggestion(passDepsFor(ws, globals), id, sid);
      } catch (error) {
        if (error instanceof ChainInvalidError) {
          sendError(res, 400, error.message, error.code, error.cycle !== undefined ? { cycle: error.cycle } : undefined);
          return;
        }
        throw error;
      }
      switch (result.status) {
        case 'applied':
          res.status(201).json(result.version);
          return;
        case 'conflict':
          sendError(res, 409, 'The instructions changed since this was suggested.', 'LOUSHO_SUGGESTION_CONFLICT');
          return;
        case 'not_found':
          sendError(res, 404, `No suggestion '${sid}' for agent '${id}'`, 'LOUSHO_SUGGESTION_NOT_FOUND');
          return;
        case 'not_open':
          sendError(res, 409, NOT_OPEN_MESSAGE, 'LOUSHO_SUGGESTION_NOT_OPEN');
          return;
        case 'unsupported':
          sendError(
            res,
            409,
            'The instructions are stored in a file, so this suggestion cannot be applied here.',
            'LOUSHO_SUGGESTION_UNSUPPORTED'
          );
          return;
        case 'invalid':
          sendError(
            res,
            400,
            `Applying this suggestion would make the spec invalid: ${result.issues[0].path}: ${result.issues[0].message}`,
            'LOUSHO_SPEC_INVALID',
            { issues: result.issues }
          );
          return;
      }
    })
  );

  // Dismiss: the record stays in the list as `dismissed`; the working
  // copy is untouched.
  app.post(
    '/agents/:id/suggestions/:sid/dismiss',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      const id = paramId(req);
      const sid = paramSid(req, res);
      if (sid === undefined) return;
      await withAgentLock(id, async () => {
        const suggestion = await openSuggestion(ws, res, id, sid);
        if (suggestion === undefined) return;
        await ws.suggestions.setStatus(id, sid, 'dismissed', { resolvedAt: new Date().toISOString() });
        res.status(204).end();
      });
    })
  );
}
