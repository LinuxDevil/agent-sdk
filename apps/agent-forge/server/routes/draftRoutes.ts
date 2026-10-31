/**
 * Draft routes - `GET/POST/DELETE /agents/:id/draft` and
 * `POST /agents/:id/draft/approve` · `/reject` (Contract C).
 *
 * A pending `ChangeDraft` is a proposed spec patch sitting in
 * `.lousho/agents/<id>/drafts/current.json` (at most one per agent - the
 * DraftStore owns the files). Creating a draft never touches the working
 * copy or the versions; approving applies the patch over the *current*
 * spec and labels (so edits made after the draft was written survive),
 * then writes exactly one `source: 'draft'` version; rejecting and
 * withdrawing only move the draft to history.
 *
 * Every handler reads its workspace's stores from `workspaceOf(req)` and
 * serializes each draft's read-modify-write inside `withAgentLock(id)` -
 * the stores themselves stay lock-free.
 */
import type { Express, Response } from 'express';
import { agentSpecV2Schema } from '@lousho/build-ai-agent';
import { computeChangedFields, SPEC_FIELD_ORDER } from '../../shared/specFields';
import type {
  CreateDraftRequest,
  DraftOrigin,
  SettleDraftRequest,
  SpecPatch,
  SpecSnapshot,
} from '../../shared/wireTypes';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { workspaceOf } from '../workspace/middleware';
import { withAgentLock } from '../storage/atomic';
import { applySpecPatch, DraftMismatchError, NoDraftError } from '../storage/draftStore';
import { specHash } from '../storage/specHash';

const DRAFT_ORIGINS: readonly DraftOrigin[] = ['author', 'suggestion', 'manual'];
const REASON_MAX_CHARS = 2000;
const NOTE_MAX_CHARS = 2000;

/** The exact 409 message a stale sheet gets (Contract C's draft rows). */
const STALE_DRAFT_MESSAGE = 'This draft was replaced. Reload to see the current one.';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A validated `POST /agents/:id/draft` body, or the 400 message: `patch`
 * is a plain object with at least one key and only draftable fields (the
 * canonical spec fields plus `labels`; `version` is not one of them),
 * `origin` is a known source, `reason` a non-empty string within the cap.
 */
function parseCreateDraft(body: unknown): CreateDraftRequest | string {
  if (!isObject(body)) return 'Request body must be an object';
  if (!isObject(body.patch) || Object.keys(body.patch).length === 0) {
    return "'patch' must be an object with at least one spec field";
  }
  const badKey = Object.keys(body.patch).find((key) => !SPEC_FIELD_ORDER.includes(key));
  if (badKey !== undefined) return `'patch.${badKey}' is not a draftable field`;
  if (!DRAFT_ORIGINS.includes(body.origin as DraftOrigin)) {
    return "'origin' must be 'author', 'suggestion' or 'manual'";
  }
  if (typeof body.reason !== 'string' || body.reason.trim().length === 0 || body.reason.length > REASON_MAX_CHARS) {
    return `'reason' must be a string of 1-${REASON_MAX_CHARS} characters`;
  }
  return { patch: body.patch as SpecPatch, origin: body.origin as DraftOrigin, reason: body.reason };
}

/** A validated approve/reject body, or the 400 message: optional `draftId` and `note`, both strings. */
function parseSettleDraft(body: unknown): SettleDraftRequest | string {
  const value = body === undefined || body === null ? {} : body;
  if (!isObject(value)) return 'Request body must be an object';
  if (value.draftId !== undefined && typeof value.draftId !== 'string') return "'draftId' must be a string";
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > NOTE_MAX_CHARS)) {
    return `'note' must be a string of at most ${NOTE_MAX_CHARS} characters`;
  }
  return { draftId: value.draftId as string | undefined, note: value.note as string | undefined };
}

/** One validation problem as `agentSpecV2Schema.safeParse` reports it (structural - mirrors agentRepo's). */
interface SpecSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

/** An issue's path joined with dots (object segments carry their `key`) - same flattening agentRepo reports. */
function issueDotPath(issue: SpecSchemaIssue): { path: string; message: string } {
  const path = (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.');
  return { path, message: issue.message };
}

/**
 * The 400 LOUSHO_DRAFT_INVALID for a patch whose result fails the spec
 * schema - sent identically from create (patch over the current spec) and
 * approve (the stored patch over today's spec).
 */
function sendInvalidDraft(res: Response, issues: readonly SpecSchemaIssue[]): void {
  const flat = issues.map(issueDotPath);
  sendError(
    res,
    400,
    `This draft's patch would make the spec invalid: ${flat[0].path}: ${flat[0].message}`,
    'LOUSHO_DRAFT_INVALID',
    { issues: flat }
  );
}

/** Draft-store errors → HTTP: no pending draft is a 404, a replaced id is the stale-sheet 409. */
function sendDraftStoreError(res: Response, error: unknown): void {
  if (error instanceof NoDraftError) {
    sendError(res, 404, error.message, error.code);
    return;
  }
  if (error instanceof DraftMismatchError) {
    sendError(res, 409, STALE_DRAFT_MESSAGE, error.code);
    return;
  }
  throw error;
}

/** The pending draft the request may settle: throws the mapped errors for none-found / wrong-id. */
async function pendingDraft(ws: ReturnType<typeof workspaceOf>, agentId: string, draftId: string | undefined) {
  const cur = await ws.drafts.current(agentId);
  if (cur === undefined) throw new NoDraftError(agentId);
  if (draftId !== undefined && draftId !== cur.id) throw new DraftMismatchError(agentId, draftId);
  return cur;
}

/**
 * Registers the draft routes. There are no deps: handlers read `repo`,
 * `versions` and `drafts` off `workspaceOf(req)` (the workspace seam), so
 * a second workspace is a second context, not a second registration.
 */
export function registerDraftRoutes(app: Express): void {
  // The pending draft: 200 ChangeDraft, 204 when there is none, 404 for an unknown agent.
  app.get(
    '/agents/:id/draft',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      const id = paramId(req);
      if (!ws.repo.exists(id)) {
        sendError(res, 404, `No saved agent '${id}'`, 'LOUSHO_AGENT_NOT_FOUND');
        return;
      }
      const draft = await ws.drafts.current(id);
      if (draft === undefined) {
        res.status(204).end();
        return;
      }
      res.json(draft);
    })
  );

  // Create a pending draft: validates the patch produces a changed, valid
  // spec, then lets the store displace any existing pending draft to
  // history as withdrawn.
  app.post(
    '/agents/:id/draft',
    asyncRoute(async (req, res) => {
      const parsed = parseCreateDraft(req.body);
      if (typeof parsed === 'string') {
        sendError(res, 400, parsed, 'LOUSHO_BODY_INVALID');
        return;
      }
      const ws = workspaceOf(req);
      const id = paramId(req);
      await withAgentLock(id, async () => {
        const spec = await ws.repo.readSpec(id);
        if (spec === undefined) {
          sendError(res, 404, `No saved agent '${id}'`, 'LOUSHO_AGENT_NOT_FOUND');
          return;
        }
        const base: SpecSnapshot = { spec, labels: (await ws.repo.readMeta(id)).labels };
        const next = applySpecPatch(base, parsed.patch);
        const validation = agentSpecV2Schema.safeParse(next.spec);
        if (!validation.success) {
          sendInvalidDraft(res, validation.error.issues);
          return;
        }
        if (computeChangedFields(base, next).length === 0) {
          sendError(res, 400, 'This draft matches the current agent.', 'LOUSHO_DRAFT_EMPTY');
          return;
        }
        const { draft } = await ws.drafts.create(id, {
          patch: parsed.patch,
          origin: parsed.origin,
          reason: parsed.reason,
          baseVersion: (await ws.versions.latest(id))?.version ?? null,
          baseSpecHash: specHash(spec),
        });
        res.status(201).json(draft);
      });
    })
  );

  // Withdraw the pending draft (whatever it is) to history.
  app.delete(
    '/agents/:id/draft',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      const id = paramId(req);
      try {
        const settled = await withAgentLock(id, () => ws.drafts.settle(id, 'withdrawn'));
        res.json(settled);
      } catch (error) {
        sendDraftStoreError(res, error);
      }
    })
  );

  // Approve: the stored patch is applied over the CURRENT spec + labels -
  // not the base it was drafted against, so a sheet left open while the
  // canvas moved on still lands cleanly (the drift check is draftId).
  app.post(
    '/agents/:id/draft/approve',
    asyncRoute(async (req, res) => {
      const parsed = parseSettleDraft(req.body);
      if (typeof parsed === 'string') {
        sendError(res, 400, parsed, 'LOUSHO_BODY_INVALID');
        return;
      }
      const ws = workspaceOf(req);
      const id = paramId(req);
      try {
        await withAgentLock(id, async () => {
          const cur = await pendingDraft(ws, id, parsed.draftId);
          // A hand edit since the last Studio write is preserved as a
          // baseline version before the draft overwrites the file.
          await ws.versions.reconcileExternalEdit(id);
          const spec = await ws.repo.readSpec(id);
          if (spec === undefined) {
            sendError(res, 404, `No saved agent '${id}'`, 'LOUSHO_AGENT_NOT_FOUND');
            return;
          }
          const meta = await ws.repo.readMeta(id);
          const next = applySpecPatch({ spec, labels: meta.labels }, cur.patch);
          const validation = agentSpecV2Schema.safeParse(next.spec);
          if (!validation.success) {
            sendInvalidDraft(res, validation.error.issues);
            return;
          }
          await ws.repo.writeSpec(id, next.spec);
          if ('labels' in cur.patch) {
            await ws.repo.writeMeta(id, { ...meta, labels: next.labels, updatedAt: new Date().toISOString() });
          }
          await ws.versions.capture(id, { kind: 'update', source: 'draft' });
          const settled = await ws.drafts.settle(id, 'approved', { draftId: cur.id, note: parsed.note });
          res.json(settled);
        });
      } catch (error) {
        sendDraftStoreError(res, error);
      }
    })
  );

  // Reject: keeps the working copy, only moves the draft to history.
  app.post(
    '/agents/:id/draft/reject',
    asyncRoute(async (req, res) => {
      const parsed = parseSettleDraft(req.body);
      if (typeof parsed === 'string') {
        sendError(res, 400, parsed, 'LOUSHO_BODY_INVALID');
        return;
      }
      const ws = workspaceOf(req);
      const id = paramId(req);
      try {
        await withAgentLock(id, async () => {
          const cur = await pendingDraft(ws, id, parsed.draftId);
          const settled = await ws.drafts.settle(id, 'rejected', { draftId: cur.id, note: parsed.note });
          res.json(settled);
        });
      } catch (error) {
        sendDraftStoreError(res, error);
      }
    })
  );
}
