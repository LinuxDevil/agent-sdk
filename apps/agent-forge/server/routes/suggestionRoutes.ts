/**
 * Suggestion routes - `GET /agents/:id/suggestions` and
 * `POST /agents/:id/suggestions/:sid/apply` · `/dismiss` (Contract C's
 * suggestion rows; the Suggestions tab's API).
 *
 * The `suggestions/` folder holds two record kinds (see
 * storage/suggestionStore.ts); only `prompt_edit` records are
 * suggestions - `GET` filters portability analyses out and settling
 * routes answer them 404.
 *
 * Apply is compare-and-swap on the instructions: inside the per-agent
 * lock it reconciles an external edit (a hand-edited yaml is baselined
 * first), then lands the anchored `oldText` → `newText` rewrite only
 * when the instructions still hash to `expectedPromptHash` AND `oldText`
 * occurs exactly once - anything else marks the record `conflict`. A
 * landed apply writes one `kind: 'update', source: 'suggestion'`
 * version before the record goes `applied`.
 *
 * Every handler reads `repo`, `versions` and `suggestions` off
 * `workspaceOf(req)` (the workspace seam); the stores stay lock-free and
 * the writers serialize through `withAgentLock(id)`.
 */
import type { Express, Request, Response } from 'express';
import { agentSpecV2Schema } from 'lousho';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { flattenSpecIssues } from '../storage/agentRepo';
import { withAgentLock } from '../storage/atomic';
import { promptHash, SUGGESTION_ID_RE } from '../storage/suggestionStore';
import { workspaceOf } from '../workspace/middleware';
import type { WorkspaceContext } from '../workspace/context';
import type { PromptSuggestion } from '../../shared/wireTypes';

/** The exact 409 message a settled suggestion gets (Contract C). */
const NOT_OPEN_MESSAGE = 'This suggestion was already applied or dismissed.';

/**
 * How often `needle` occurs in `haystack`, counted by repeated `indexOf`
 * (never regex - `oldText` may contain regex metacharacters). An empty
 * needle counts as 0, which fails the exactly-once check rather than
 * looping forever on `indexOf('', from) === from`.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
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
 * The open `prompt_edit` record `sid` names, or `undefined` once the
 * 404/409 was sent: a missing record (or a portability analysis, which
 * is not a suggestion) is a 404, a settled one a 409.
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

/**
 * Registers the suggestion routes. No deps: handlers read `repo`,
 * `versions` and `suggestions` off `workspaceOf(req)`, so a second
 * workspace is a second context, not a second registration.
 */
export function registerSuggestionRoutes(app: Express): void {
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

  // Apply: the CAS-guarded instructions edit. `expectedPromptHash` must
  // still match and `oldText` must occur exactly once (a hand edit is
  // baselined first, so it shows up as a conflict, not a silent skip);
  // the rewrite goes through the replacer-function form so `newText`'s
  // `$&`/`$1` are inserted literally. Lands as a source:'suggestion'
  // version, then the record goes `applied`.
  app.post(
    '/agents/:id/suggestions/:sid/apply',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      const id = paramId(req);
      const sid = paramSid(req, res);
      if (sid === undefined) return;
      await withAgentLock(id, async () => {
        const suggestion = await openSuggestion(ws, res, id, sid);
        if (suggestion === undefined) return;
        await ws.versions.reconcileExternalEdit(id);
        const spec = await ws.repo.readSpec(id);
        if (spec === undefined) {
          sendError(res, 404, `No saved agent '${id}'`, 'LOUSHO_AGENT_NOT_FOUND');
          return;
        }
        if (typeof spec.instructions !== 'string') {
          sendError(
            res,
            409,
            'The instructions are stored in a file, so this suggestion cannot be applied here.',
            'LOUSHO_SUGGESTION_UNSUPPORTED'
          );
          return;
        }
        if (
          promptHash(spec.instructions) !== suggestion.expectedPromptHash ||
          countOccurrences(spec.instructions, suggestion.oldText) !== 1
        ) {
          await ws.suggestions.setStatus(id, sid, 'conflict');
          sendError(res, 409, 'The instructions changed since this suggestion was made.', 'LOUSHO_SUGGESTION_CONFLICT');
          return;
        }
        const next = { ...spec, instructions: spec.instructions.replace(suggestion.oldText, () => suggestion.newText) };
        const validation = agentSpecV2Schema.safeParse(next);
        if (!validation.success) {
          const issues = flattenSpecIssues(validation.error.issues);
          sendError(
            res,
            400,
            `Applying this suggestion would make the spec invalid: ${issues[0].path}: ${issues[0].message}`,
            'LOUSHO_SPEC_INVALID',
            { issues }
          );
          return;
        }
        await ws.repo.writeSpec(id, next);
        const item = await ws.versions.capture(id, { kind: 'update', source: 'suggestion' });
        await ws.suggestions.setStatus(id, sid, 'applied');
        res.status(201).json(item);
        ws.events.publish({ type: 'agent.changed', agentId: id, reason: 'version' });
      });
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
        await ws.suggestions.setStatus(id, sid, 'dismissed');
        res.status(204).end();
      });
    })
  );
}
