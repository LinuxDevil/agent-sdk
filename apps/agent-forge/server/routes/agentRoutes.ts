/**
 * Agent routes - `GET /agents`, `GET /agents/:id`, `PUT /agents/:id` and
 * `DELETE /agents/:id` (the Agents list's and detail header's API).
 *
 * `GET /agents` answers `AgentListItem[]` (spec summary + meta + counts +
 * `lastRun`) and `GET /agents/:id` the full `AgentRecord` (spec v2, meta,
 * layout, latest version). `PUT /agents/:id` takes `{ spec: AgentSpecV2 }`
 * and writes the v2 working copy; every write runs inside
 * `withAgentLock(id)` and reconciles external edits first, so a hand-edited
 * `<id>.yaml` is preserved as a `baseline` version before it is overwritten.
 *
 * The v1 canvas keeps working until C02 through the `?view=legacy` bridge:
 * the two GETs answer the old `AgentStoreEntry[]`/`AgentSpec` shapes (the
 * `agentStore` facade, `toLegacySpec`) and a bare v1 `AgentSpec` PUT body is
 * merged onto the stored v2 spec (`mergeLegacySave`), preserving v2-only
 * keys. A v2 spec sent without the `{ spec }` wrapper is NOT a v1 body and
 * gets `LOUSHO_BODY_INVALID`.
 *
 * Stores come from `workspaceOf(req)` (the workspace seam) - there are no
 * deps to close over. `toListItem`/`lastRunOf`/`countsOf`/`toRecord` take a
 * `WorkspaceContext`, never `req`, so a later ticket can lift them verbatim.
 */
import type { Express, Response } from 'express';
import type { AgentSpec, AgentSpecV2 } from 'lousho';
import type { AgentLastRun, AgentListItem, AgentRecord } from '../../shared/wireTypes';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { InvalidSpecError } from '../storage/agentRepo';
import { withAgentLock } from '../storage/atomic';
import { mergeLegacySave } from '../storage/legacySpec';
import { listAgentTraces } from '../traceStore';
import type { WorkspaceContext } from '../workspace/context';
import { workspaceOf } from '../workspace/middleware';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `counts` an `AgentListItem` carries: section sizes read off the spec as data. */
function countsOf(spec: AgentSpecV2): AgentListItem['counts'] {
  return {
    tools: spec.tools?.length ?? 0,
    mcpServers: Object.keys(spec.mcpServers ?? {}).length,
    subagents: Object.keys(spec.subagents ?? {}).length,
    triggers: spec.triggers?.length ?? 0,
  };
}

/**
 * The `lastRun` of an `AgentListItem`: the live status while a run is not
 * `idle`, else the newest persisted trace's outcome, else `undefined` when
 * the agent has never run.
 */
async function lastRunOf(ws: WorkspaceContext, id: string): Promise<AgentLastRun | undefined> {
  const live = ws.runs.status(id);
  if (live.status !== 'idle') {
    return { status: live.status, at: live.updatedAt, ...(live.traceId !== undefined && { traceId: live.traceId }) };
  }
  const [trace] = await listAgentTraces(ws.ref.root, id, 1);
  if (trace === undefined) return undefined;
  return {
    status: trace.status === 'error' ? 'error' : 'done',
    at: new Date(trace.startTime + trace.durationMs).toISOString(),
    traceId: trace.traceId,
  };
}

/** One agent's `AgentListItem`; `undefined` when the id has no spec (it can disappear mid-list). */
async function toListItem(ws: WorkspaceContext, id: string): Promise<AgentListItem | undefined> {
  const spec = await ws.repo.readSpec(id);
  if (spec === undefined) return undefined;
  const [meta, lastRun] = await Promise.all([ws.repo.readMeta(id), lastRunOf(ws, id)]);
  return {
    id,
    name: spec.name,
    description: spec.description ?? '',
    model: spec.model,
    enabled: meta.enabled,
    labels: meta.labels,
    updatedAt: ws.repo.updatedAt(id),
    publishedVersion: meta.publishedVersion,
    ...(lastRun !== undefined && { lastRun }),
    counts: countsOf(spec),
  };
}

/** One agent's `AgentRecord`; `undefined` when it has no spec file. */
async function toRecord(ws: WorkspaceContext, id: string): Promise<AgentRecord | undefined> {
  const spec = await ws.repo.readSpec(id);
  if (spec === undefined) return undefined;
  const [meta, layout, latest] = await Promise.all([
    ws.repo.readMeta(id),
    ws.repo.readLayout(id),
    ws.versions.latest(id),
  ]);
  return { id, spec, meta, layout, updatedAt: ws.repo.updatedAt(id), latestVersion: latest?.version ?? null };
}

function sendAgentNotFound(res: Response, id: string): void {
  sendError(res, 404, `No saved agent '${id}'`, 'LOUSHO_AGENT_NOT_FOUND');
}

/** A validated `PUT /agents/:id` body: a `{ spec }` v2 save, a bare v1 save, or neither. */
function parsePutBody(body: unknown): { kind: 'v2'; spec: AgentSpecV2 } | { kind: 'v1'; spec: AgentSpec } | undefined {
  if (!isObject(body)) return undefined;
  if (isObject(body.spec)) return { kind: 'v2', spec: body.spec as unknown as AgentSpecV2 };
  // A v1 body carries `prompt`/`provider` and never `version`; a bare v2
  // object fails this check and is rejected rather than silently upgraded.
  if (body.version === undefined && typeof body.prompt === 'string' && isObject(body.provider)) {
    return { kind: 'v1', spec: body as unknown as AgentSpec };
  }
  return undefined;
}

/**
 * Registers the four agent routes. No deps: handlers read `repo`,
 * `versions`, `runs` and `agentStore` off `workspaceOf(req)`, so a second
 * workspace is a second context, not a second registration.
 */
export function registerAgentRoutes(app: Express): void {
  // The Agents list. `?view=legacy` keeps the old AgentStoreEntry[] shape
  // for the v1 canvas; anything else (or no view) answers AgentListItem[].
  app.get(
    '/agents',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      if (req.query.view === 'legacy') {
        res.json(await ws.agentStore.list());
        return;
      }
      const items = await Promise.all(
        ws.repo.listIds().map(async (id) => {
          try {
            return await toListItem(ws, id);
          } catch (error) {
            console.warn(`[agent-forge] skipping unreadable agent spec '${id}': ${(error as Error).message}`);
            return undefined;
          }
        })
      );
      res.json(items.filter((item): item is AgentListItem => item !== undefined));
    })
  );

  app.get(
    '/agents/:id',
    asyncRoute(async (req, res) => {
      const ws = workspaceOf(req);
      const id = paramId(req);
      if (req.query.view === 'legacy') {
        const spec = await ws.agentStore.load(id);
        if (spec === undefined) {
          sendAgentNotFound(res, id);
          return;
        }
        res.json(spec);
        return;
      }
      const record = await toRecord(ws, id);
      if (record === undefined) {
        sendAgentNotFound(res, id);
        return;
      }
      res.json(record);
    })
  );

  app.put(
    '/agents/:id',
    asyncRoute(async (req, res) => {
      const parsed = parsePutBody(req.body);
      if (parsed === undefined) {
        sendError(
          res,
          400,
          'Request body must be { spec } with an AgentSpec v2, or a v1 AgentSpec',
          'LOUSHO_BODY_INVALID'
        );
        return;
      }
      const ws = workspaceOf(req);
      const id = paramId(req);
      try {
        // One lock around reconcile + read + write: a hand-edited yaml is
        // baselined before it is overwritten, and a v1 body is merged onto
        // the stored v2 spec so v2-only keys survive.
        await withAgentLock(id, async () => {
          await ws.versions.reconcileExternalEdit(id);
          const spec = parsed.kind === 'v2' ? parsed.spec : mergeLegacySave(await ws.repo.readSpec(id), parsed.spec);
          await ws.repo.writeSpec(id, spec);
        });
      } catch (error) {
        if (error instanceof InvalidSpecError) {
          sendError(res, 400, error.message, error.code, { issues: error.issues });
          return;
        }
        throw error;
      }
      res.status(204).end();
    })
  );

  app.delete(
    '/agents/:id',
    asyncRoute(async (req, res) => {
      await workspaceOf(req).repo.remove(paramId(req));
      res.status(204).end();
    })
  );
}
