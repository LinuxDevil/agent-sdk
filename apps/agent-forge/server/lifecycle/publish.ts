/**
 * Publish pointer (L14a) - `POST /agents/:id/publish` pins a version into
 * `meta.publishedVersion`; serve/MCP/deploy/eval read the published spec
 * through `readPublishedSpec`.
 *
 * Without an explicit `version`, publishing first captures the working copy
 * as a `kind: 'publish'` version - skipped when the working copy's spec hash
 * already equals the latest version's, so an unchanged agent pins the latest
 * without growing history - then pins that version. `GET /agents/:id` reports
 * the pointer's state (`publishState`) so the UI can tell whether the working
 * copy has drifted from what is published.
 *
 * `publishAgent` runs under `withAgentLock(id)`; X01b adds the eval gate and
 * X05 the `published.yaml` write inside it.
 */
import type { Express, Request, Response } from 'express';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type { AgentMeta, PublishState, VersionListItem } from '../../shared/wireTypes';
import type { StudioEventBus } from '../events/eventBus';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import type { AgentRepo } from '../storage/agentRepo';
import { withAgentLock } from '../storage/atomic';
import { specHash } from '../storage/specHash';
import type { VersionStore } from '../storage/versionStore';
import { workspaceOf } from '../workspace/middleware';

/** What `publishAgent`/`readPublishedSpec` need: the workspace's repo, versions and event bus. */
export interface PublishDeps {
  repo: AgentRepo;
  versions: VersionStore;
  events: StudioEventBus;
}

/** A publish failure with its HTTP status and wire `code`. */
export class PublishError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
    readonly code: string
  ) {
    super(message);
  }
}

/**
 * Pins `opts.version` (or the working copy's freshly captured `publish`
 * version) as the agent's published version. Idempotent: pinning the already
 * published version writes nothing and emits no event.
 */
export async function publishAgent(
  id: string,
  opts: { version?: number },
  deps: PublishDeps
): Promise<{ publishedVersion: number }> {
  return withAgentLock(id, async () => {
    if (!deps.repo.exists(id)) {
      throw new PublishError(`No agent '${id}'`, 404, 'LOUSHO_AGENT_NOT_FOUND');
    }
    const meta = await deps.repo.readMeta(id);
    let target: number;
    if (opts.version !== undefined) {
      if ((await deps.versions.get(id, opts.version)) === undefined) {
        throw new PublishError(`No version ${opts.version}.`, 404, 'LOUSHO_VERSION_NOT_FOUND');
      }
      target = opts.version;
    } else {
      const spec = await deps.repo.readSpec(id);
      const latest = await deps.versions.latest(id);
      // The working copy already IS the latest version: pin it without
      // growing history (labels are meta state, not part of the pin).
      if (spec !== undefined && latest !== undefined && specHash(spec) === latest.specHash) {
        target = latest.version;
      } else {
        const item = await deps.versions.capture(id, { kind: 'publish', source: 'editor' });
        // 'publish' captures are never no-op-skipped, but stay defensive:
        // fall back to whatever the newest version is after the write.
        const written = item?.version ?? (await deps.versions.latest(id))?.version;
        if (written === undefined) {
          throw new PublishError(`No version could be written for '${id}'`, 409, 'LOUSHO_PUBLISH_FAILED');
        }
        target = written;
      }
    }
    if (target === meta.publishedVersion) return { publishedVersion: target };
    await deps.repo.writeMeta(id, { ...meta, publishedVersion: target, updatedAt: new Date().toISOString() });
    deps.events.publish({ type: 'agent.changed', agentId: id, reason: 'meta' });
    return { publishedVersion: target };
  });
}

/**
 * The published version's snapshot spec, or `undefined` when nothing is
 * published (no pointer, or the pinned record is gone). Serve/MCP/deploy and
 * the eval gate read the published spec through this one helper.
 */
export async function readPublishedSpec(
  id: string,
  deps: Pick<PublishDeps, 'repo' | 'versions'>
): Promise<{ version: number; spec: AgentSpecV2 } | undefined> {
  const meta = await deps.repo.readMeta(id);
  if (meta.publishedVersion === null) return undefined;
  const record = await deps.versions.get(id, meta.publishedVersion);
  if (record === undefined) return undefined;
  return { version: record.version, spec: record.snapshot.spec };
}

/**
 * The `PublishState` for `GET /agents/:id`: the pointer from `meta`, drift
 * from the working copy's spec hash against the pinned version's, and the
 * pin's timestamp. `published` is the pinned version's list item/record.
 */
export function publishStateOf(meta: AgentMeta, workingHash: string, published: VersionListItem | undefined): PublishState {
  return {
    version: meta.publishedVersion,
    matchesWorkingCopy:
      meta.publishedVersion !== null && published !== undefined && published.specHash === workingHash,
    publishedAt: published?.createdAt ?? null,
  };
}

/** A positive-integer `version`, `undefined` when absent, `null` when invalid. */
function parseVersion(body: unknown): number | undefined | null {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const version = (body as Record<string, unknown>).version;
  if (version === undefined) return undefined;
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : null;
}

/**
 * `POST /agents/:id/publish` - `{ version?: number }` pins that version (or
 * the working copy's new `publish` version) and answers `{ publishedVersion }`.
 * Stores come from `workspaceOf(req)` (the workspace seam), like the other
 * lifecycle routes.
 */
export function registerPublishRoutes(app: Express): void {
  app.post(
    '/agents/:id/publish',
    asyncRoute(async (req: Request, res: Response) => {
      const version = parseVersion(req.body);
      if (version === null) {
        sendError(res, 400, 'version must be a positive integer');
        return;
      }
      const ws = workspaceOf(req);
      try {
        const result = await publishAgent(paramId(req), { version }, {
          repo: ws.repo,
          versions: ws.versions,
          events: ws.events,
        });
        res.json(result);
      } catch (error) {
        if (error instanceof PublishError) {
          sendError(res, error.status, error.message, error.code);
          return;
        }
        throw error;
      }
    })
  );
}
