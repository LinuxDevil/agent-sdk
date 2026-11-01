/**
 * Version routes - `GET/POST /agents/:id/versions`,
 * `GET /agents/:id/versions/:n`, `GET /agents/:id/versions/:n/diff` and
 * `POST /agents/:id/versions/:n/restore` (the Versions tab's API).
 *
 * The version history is append-only: an explicit save captures the
 * working copy (`kind: 'create'` the first time, 'update' after - a no-op
 * `update` answers 200 with the existing item), and a restore writes a
 * NEW `kind: 'restore'` version rather than rewinding history. Reads never
 * take the agent lock; the two writers run inside `withAgentLock(id)` and
 * reconcile external edits first, so a hand-edited `<id>.yaml` is
 * preserved as a baseline before either overwrites or snapshots it.
 *
 * Stores come from `workspaceOf(req)` (the workspace seam) - there are no
 * deps to close over.
 */
import type { Express, Response } from 'express';
import { agentSpecV2Schema } from 'lousho';
import { diffSpecs } from '../diff/specChange';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { withAgentLock } from '../storage/atomic';
import { flattenSpecIssues } from '../storage/agentRepo';
import { workspaceOf } from '../workspace/middleware';
import type { SpecSnapshot } from '../../shared/wireTypes';

/** A version number is a positive whole number in the path (`/versions/7`), at most 9 digits. */
const VERSION_RE = /^[1-9][0-9]{0,8}$/;

/** `raw` (a route param or query value) as a version number, or `undefined` when it is not one. */
function parseVersionParam(raw: unknown): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && VERSION_RE.test(value) ? Number(value) : undefined;
}

function sendVersionInvalid(res: Response): void {
  sendError(res, 400, 'Version must be a positive whole number', 'LOUSHO_VERSION_INVALID');
}

function sendVersionNotFound(res: Response, id: string, n: number): void {
  sendError(res, 404, `No version ${n} of '${id}'`, 'LOUSHO_VERSION_NOT_FOUND');
}

/** The snapshot `n` diffs against: the explicit `against`, else the highest version below `n`, else none (all adds). */
async function diffBase(
  ws: ReturnType<typeof workspaceOf>,
  id: string,
  n: number,
  against: number | undefined
): Promise<{ snapshot: SpecSnapshot | undefined } | { missing: number }> {
  if (against !== undefined) {
    const rec = await ws.versions.get(id, against);
    return rec === undefined ? { missing: against } : { snapshot: rec.snapshot };
  }
  const below = (await ws.versions.list(id)).find((item) => item.version < n);
  if (below === undefined) return { snapshot: undefined };
  return { snapshot: (await ws.versions.get(id, below.version))?.snapshot };
}

/**
 * Registers the version routes. No deps: handlers read `repo` and
 * `versions` off `workspaceOf(req)`, so a second workspace is a second
 * context, not a second registration.
 */
export function registerVersionRoutes(app: Express): void {
  // The version list, newest first. An agent is 404 only when neither a
  // spec file nor any version exists (a deleted spec keeps its history).
  app.get(
    '/agents/:id/versions',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      const id = paramId(req);
      const items = await ws.versions.list(id);
      if (items.length === 0 && !ws.repo.exists(id)) {
        sendError(res, 404, `No saved agent '${id}'`, 'LOUSHO_AGENT_NOT_FOUND');
        return;
      }
      res.json(items);
    })
  );

  // Explicit "Save version" of the working copy: 201 with the new item,
  // or 200 with the latest item when nothing changed since it (the
  // VersionStore's no-op `update`).
  app.post(
    '/agents/:id/versions',
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { source?: unknown };
      if (body.source !== undefined && body.source !== 'editor') {
        sendError(res, 400, "'source' must be 'editor'", 'LOUSHO_BODY_INVALID');
        return;
      }
      const ws = workspaceOf(req);
      const id = paramId(req);
      await withAgentLock(id, async () => {
        if (!ws.repo.exists(id)) {
          sendError(res, 404, `No saved agent '${id}'`, 'LOUSHO_AGENT_NOT_FOUND');
          return;
        }
        await ws.versions.reconcileExternalEdit(id);
        const latest = await ws.versions.latest(id);
        const item = await ws.versions.capture(id, { kind: latest ? 'update' : 'create', source: 'editor' });
        res.status(item === null ? 200 : 201).json(item ?? latest);
      });
    })
  );

  app.get(
    '/agents/:id/versions/:n',
    asyncRoute(async (req, res) => {
      const id = paramId(req);
      const n = parseVersionParam(req.params.n);
      if (n === undefined) {
        sendVersionInvalid(res);
        return;
      }
      const rec = await workspaceOf(req).versions.get(id, n);
      if (rec === undefined) {
        sendVersionNotFound(res, id, n);
        return;
      }
      res.json(rec);
    })
  );

  // The SpecChange[] `n` introduces over `against` (or over the highest
  // version below it - or nothing, making every field an add).
  app.get(
    '/agents/:id/versions/:n/diff',
    asyncRoute(async (req, res) => {
      const id = paramId(req);
      const n = parseVersionParam(req.params.n);
      const againstRaw = req.query.against;
      const against = againstRaw === undefined ? undefined : parseVersionParam(againstRaw);
      if (n === undefined || (againstRaw !== undefined && against === undefined)) {
        sendVersionInvalid(res);
        return;
      }
      const ws = workspaceOf(req);
      const rec = await ws.versions.get(id, n);
      if (rec === undefined) {
        sendVersionNotFound(res, id, n);
        return;
      }
      const base = await diffBase(ws, id, n, against);
      if ('missing' in base) {
        sendVersionNotFound(res, id, base.missing);
        return;
      }
      res.json(diffSpecs(base.snapshot, rec.snapshot));
    })
  );

  // Forward restore: write the stored snapshot back to the working copy
  // (re-validated against today's schema), restore its labels, keep
  // meta.enabled untouched, and record a kind:'restore' version.
  app.post(
    '/agents/:id/versions/:n/restore',
    asyncRoute(async (req, res) => {
      const id = paramId(req);
      const n = parseVersionParam(req.params.n);
      if (n === undefined) {
        sendVersionInvalid(res);
        return;
      }
      const ws = workspaceOf(req);
      await withAgentLock(id, async () => {
        await ws.versions.reconcileExternalEdit(id);
        const rec = await ws.versions.get(id, n);
        if (rec === undefined) {
          sendVersionNotFound(res, id, n);
          return;
        }
        const parsed = agentSpecV2Schema.safeParse(rec.snapshot.spec);
        if (!parsed.success) {
          const issues = flattenSpecIssues(parsed.error.issues);
          sendError(
            res,
            400,
            `Version ${n} no longer passes validation: ${issues[0].path}: ${issues[0].message}`,
            'LOUSHO_RESTORE_INVALID',
            { issues }
          );
          return;
        }
        await ws.repo.writeSpec(id, parsed.data);
        const meta = await ws.repo.readMeta(id);
        await ws.repo.writeMeta(id, { ...meta, labels: rec.snapshot.labels, updatedAt: new Date().toISOString() });
        const item = await ws.versions.capture(id, {
          kind: 'restore',
          source: 'restore',
          restoredFromVersion: n,
        });
        res.status(201).json(item);
      });
    })
  );
}
