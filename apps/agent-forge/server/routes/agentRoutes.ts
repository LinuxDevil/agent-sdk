/**
 * Agent routes - `GET /agents`, `POST /agents`, `GET /agents/:id`,
 * `PUT /agents/:id`, `PATCH /agents/:id/meta`, `PUT /agents/:id/layout`
 * and `DELETE /agents/:id` (the Agents list's and detail header's API).
 *
 * `GET /agents` answers `AgentListItem[]` (spec summary + meta + counts +
 * `lastRun`) and `GET /agents/:id` the full `AgentRecord` (spec v2, meta,
 * layout, latest version). `PUT /agents/:id` takes `{ spec: AgentSpecV2 }`
 * and writes the v2 working copy; every write runs inside
 * `withAgentLock(id)` and reconciles external edits first, so a hand-edited
 * `<id>.yaml` is preserved as a `baseline` version before it is overwritten.
 *
 * `POST /agents` creates a blank agent or a copy (`{ from: 'blank' |
 * { copyOf } }`; `{ template }` is `LOUSHO_TEMPLATE_UNAVAILABLE` until
 * template creation lands), writing spec + meta (+ layout, for a copy)
 * and the version-1 `create` capture inside the new agent's lock.
 * `PATCH /agents/:id/meta` toggles `enabled` and stores normalised
 * labels without writing a version; `PUT /agents/:id/layout` stores the
 * canvas layout after `parseCanvasLayout` clears it.
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
import { isValidAgentId } from '../../shared/agentId';
import { labelsProblem, MAX_LABEL_LENGTH, MAX_LABELS, normalizeLabels } from '../../shared/labels';
import type {
  AgentLastRun,
  AgentListItem,
  AgentMeta,
  AgentRecord,
  CanvasLayout,
  PatchAgentMetaRequest,
} from '../../shared/wireTypes';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { defaultMeta, InvalidSpecError } from '../storage/agentRepo';
import { copyAgentId, slugAgentId, uniqueAgentId } from '../storage/agentIds';
import { withAgentLock } from '../storage/atomic';
import { mergeLegacySave } from '../storage/legacySpec';
import { parseCanvasLayout } from './layoutValidation';
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

/** A validated `POST /agents` body: which of the three `from` shapes, plus the optional display name. */
type ParsedCreateBody =
  | { kind: 'blank'; name?: string }
  | { kind: 'template' }
  | { kind: 'copy'; copyOf: string; name?: string };

/**
 * A validated `POST /agents` body, or the 400 message: `from` must be
 * `'blank'`, `{ template: string }` or `{ copyOf: string }`; `name`, when
 * given, a string.
 */
function parseCreateBody(body: unknown): ParsedCreateBody | string {
  if (!isObject(body)) return 'Request body must be an object';
  if (body.name !== undefined && typeof body.name !== 'string') return "'name' must be a string";
  const name = body.name as string | undefined;
  const from = body.from;
  if (from === 'blank') return { kind: 'blank', name };
  if (isObject(from)) {
    if (typeof from.template === 'string') return { kind: 'template' };
    if (typeof from.copyOf === 'string') return { kind: 'copy', copyOf: from.copyOf, name };
  }
  return "'from' must be 'blank', { template: string } or { copyOf: string }";
}

/** `text` clamped to the spec-name cap (64 chars) - keeps `'<name> copy'` a valid spec name. */
function cut64(text: string): string {
  return text.slice(0, 64);
}

/**
 * The spec + meta (+ layout) write and the version-1 `create` capture a
 * new agent gets, all inside `withAgentLock(newId)` - then the same
 * `AgentRecord` `GET /agents/:id` answers.
 */
async function writeNewAgent(
  ws: WorkspaceContext,
  id: string,
  spec: AgentSpecV2,
  meta: AgentMeta,
  layout: CanvasLayout | undefined
): Promise<AgentRecord> {
  await withAgentLock(id, async () => {
    await ws.repo.writeSpec(id, spec);
    await ws.repo.writeMeta(id, meta);
    if (layout !== undefined) await ws.repo.writeLayout(id, layout);
    await ws.versions.capture(id, { kind: 'create', source: 'editor' });
  });
  const record = await toRecord(ws, id);
  if (record === undefined) throw new Error(`Agent '${id}' vanished right after creation`);
  return record;
}

/**
 * The blank `POST /agents`: the default spec under a slug of the name
 * (`uniqueAgentId` skips ids whose spec OR sidecar dir exists), enabled
 * `createdFrom: { kind: 'blank' }` meta.
 */
async function createBlankAgent(ws: WorkspaceContext, name: string | undefined): Promise<AgentRecord> {
  const spec: AgentSpecV2 = {
    version: 2,
    name: name ?? 'Untitled agent',
    model: 'mock/mock-1',
    instructions: 'You are a helpful agent.',
  };
  const meta: AgentMeta = { ...defaultMeta(new Date().toISOString()), createdFrom: { kind: 'blank' } };
  const id = uniqueAgentId(ws.repo, slugAgentId(name ?? 'untitled-agent'));
  return writeNewAgent(ws, id, spec, meta, undefined);
}

/**
 * The copy `POST /agents`: the source spec renamed `'<name> copy'` (or
 * `name`), labels and layout copied, enabled `createdFrom: { kind:
 * 'copy', ref }` meta, `publishedVersion: null` - the copy is never born
 * published. `undefined` when `copyOf` names no saved agent.
 */
async function createAgentCopy(
  ws: WorkspaceContext,
  copyOf: string,
  name: string | undefined
): Promise<AgentRecord | undefined> {
  if (!isValidAgentId(copyOf)) return undefined;
  const source = await ws.repo.readSpec(copyOf);
  if (source === undefined) return undefined;
  const spec: AgentSpecV2 = { ...source, name: name ?? cut64(`${source.name} copy`) };
  const meta: AgentMeta = {
    ...defaultMeta(new Date().toISOString()),
    labels: (await ws.repo.readMeta(copyOf)).labels,
    createdFrom: { kind: 'copy', ref: copyOf },
  };
  const layout = await ws.repo.readLayout(copyOf);
  const id = copyAgentId(ws.repo, copyOf);
  return writeNewAgent(ws, id, spec, meta, layout);
}

/** A validated `PATCH /agents/:id/meta` body, or the 400 message: at least one of `enabled`/`labels`, correctly typed. */
function parseMetaBody(body: unknown): PatchAgentMetaRequest | string {
  if (!isObject(body)) return 'Request body must be an object';
  const { enabled, labels } = body;
  if (enabled === undefined && labels === undefined) {
    return "Request body must include 'enabled' or 'labels'";
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') return "'enabled' must be a boolean";
  if (labels !== undefined && (!Array.isArray(labels) || !labels.every((label) => typeof label === 'string'))) {
    return "'labels' must be a string array";
  }
  return { enabled: enabled as boolean | undefined, labels: labels as string[] | undefined };
}

/**
 * Registers the agent routes. No deps: handlers read `repo`,
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

  // Create an agent: blank spec or copy of an existing one. Both write
  // spec + meta (+ layout for a copy) and capture version 1 inside the
  // new agent's lock, answering the same AgentRecord GET returns.
  // `{ template }` is a 400 until template creation lands.
  app.post(
    '/agents',
    asyncRoute(async (req, res) => {
      const parsed = parseCreateBody(req.body);
      if (typeof parsed === 'string') {
        sendError(res, 400, parsed, 'LOUSHO_BODY_INVALID');
        return;
      }
      if (parsed.kind === 'template') {
        sendError(res, 400, 'Creating from a template is not available yet.', 'LOUSHO_TEMPLATE_UNAVAILABLE');
        return;
      }
      const ws = workspaceOf(req);
      try {
        if (parsed.kind === 'copy') {
          const record = await createAgentCopy(ws, parsed.copyOf, parsed.name);
          if (record === undefined) {
            sendError(res, 404, `No saved agent '${parsed.copyOf}'`, 'LOUSHO_AGENT_NOT_FOUND');
            return;
          }
          res.status(201).json(record);
          return;
        }
        res.status(201).json(await createBlankAgent(ws, parsed.name));
      } catch (error) {
        if (error instanceof InvalidSpecError) {
          sendError(res, 400, error.message, error.code, { issues: error.issues });
          return;
        }
        throw error;
      }
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

  // The enable switch and the label set. Labels are normalised (trim,
  // lowercase, dedupe) before the caps are checked; disabling stamps
  // disabledAt/'manual' and enabling clears the disable fields and the
  // failure streak. Meta changes never write a version (Contract B).
  app.patch(
    '/agents/:id/meta',
    asyncRoute(async (req, res) => {
      const parsed = parseMetaBody(req.body);
      if (typeof parsed === 'string') {
        sendError(res, 400, parsed, 'LOUSHO_BODY_INVALID');
        return;
      }
      const labels = parsed.labels === undefined ? undefined : normalizeLabels(parsed.labels);
      if (labels !== undefined) {
        const problem = labelsProblem(labels);
        if (problem !== undefined) {
          sendError(res, 400, problem, 'LOUSHO_LABELS_INVALID', {
            maxLabels: MAX_LABELS,
            maxLength: MAX_LABEL_LENGTH,
          });
          return;
        }
      }
      const ws = workspaceOf(req);
      const id = paramId(req);
      await withAgentLock(id, async () => {
        if (!ws.repo.exists(id)) {
          sendAgentNotFound(res, id);
          return;
        }
        const now = new Date().toISOString();
        const meta = await ws.repo.readMeta(id);
        const next: AgentMeta = { ...meta, updatedAt: now };
        if (parsed.enabled !== undefined) {
          next.enabled = parsed.enabled;
          if (parsed.enabled) {
            next.disabledAt = null;
            next.disabledReason = null;
            next.failureStreak = 0;
          } else {
            next.disabledAt = now;
            next.disabledReason = 'manual';
          }
        }
        if (labels !== undefined) next.labels = labels;
        await ws.repo.writeMeta(id, next);
        res.json(next);
      });
    })
  );

  // The canvas positions, validated by parseCanvasLayout first so a bad
  // body is a 400 naming the field rather than a corrupt layout.json.
  app.put(
    '/agents/:id/layout',
    asyncRoute(async (req, res) => {
      const layout = parseCanvasLayout(req.body);
      if (typeof layout === 'string') {
        sendError(res, 400, layout, 'LOUSHO_LAYOUT_INVALID');
        return;
      }
      const ws = workspaceOf(req);
      const id = paramId(req);
      if (!ws.repo.exists(id)) {
        sendAgentNotFound(res, id);
        return;
      }
      await withAgentLock(id, () => ws.repo.writeLayout(id, layout));
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
