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
 * X01b adds the eval gate between resolution and the pin: when the target
 * version's spec has `evals`, `runEvalGates` runs OUTSIDE the agent lock
 * (it can take minutes - holding the lock would stall every other write to
 * the agent), a module-level busy set answers a concurrent publish with 409
 * `LOUSHO_EVAL_GATE_BUSY`, a failed gate raises a `publish_failed` inbox
 * alert and answers 409 `LOUSHO_EVAL_GATE_FAILED` with the full
 * `EvalGateResult` - the pointer never moves. A failed gate still leaves the
 * captured `publish` version behind: saved, simply not published. X05 adds
 * the `published.yaml` write inside the final lock.
 */
import type { Express, Request, Response } from 'express';
import type { AgentSpecV2 } from 'lousho';
import type {
  AgentMeta,
  EvalGateResult,
  PublishGateFailure,
  PublishResponse,
  PublishState,
  VersionListItem,
} from '../../shared/wireTypes';
import type { AlertStore } from '../inbox/alertStore';
import type { StudioEventBus } from '../events/eventBus';
import { runEvalGates, type EvalGateDeps } from '../evals/gateRunner';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import type { PassRunner } from '../passes/passRunner';
import type { SecretsStore } from '../secretsStore';
import type { SettingsStore } from '../settingsStore';
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
  /**
   * The eval gate's services (X01b): present on the real route, absent in
   * tests that exercise the L14a path only - no `evals` section means no
   * gate either way.
   */
  evals?: PublishEvalDeps;
}

/** Everything the publish eval gate needs beyond the agent id and workspace root. */
export interface PublishEvalDeps {
  baseDir: string;
  /** The workspace id `publish_failed` alerts are stamped with. */
  workspaceId: string;
  secretsStore: SecretsStore;
  settings: SettingsStore;
  passRunner: PassRunner;
  alerts: AlertStore;
  /** Test seam: replaces `runEvalGates`. */
  runGates?: (spec: AgentSpecV2, deps: EvalGateDeps) => Promise<EvalGateResult>;
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

/** The eval gate refused the publish; `result`/`version` make the 409 body. */
// fallow-ignore-next-line unused-export -- X01b contract surface (ticket); serve/deploy callers (X02+) distinguish it from generic publish errors
export class EvalGateFailedError extends Error {
  constructor(
    readonly result: EvalGateResult,
    readonly version: number
  ) {
    super('Eval gate failed');
  }
}

/** Agent ids whose eval gate is in flight - the 409 `LOUSHO_EVAL_GATE_BUSY` guard. */
const evalGateBusy = new Set<string>();

/** The target version plus its snapshot spec, resolved under the agent lock. */
interface ResolvedPublish {
  target: number;
  spec: AgentSpecV2 | undefined;
  /** `target === meta.publishedVersion` already - pinning is a no-op, no gate. */
  alreadyPublished: boolean;
}

/** L14a's resolution half: existence checks, the `publish` capture, the target version. */
async function resolveTarget(id: string, opts: { version?: number }, deps: PublishDeps): Promise<ResolvedPublish> {
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
  const record = await deps.versions.get(id, target);
  return { target, spec: record?.snapshot.spec, alreadyPublished: target === meta.publishedVersion };
}

/** The `EvalGateDeps` for one publish: the route's services plus this agent/workspace. */
function evalDepsFor(id: string, evals: PublishEvalDeps): EvalGateDeps {
  return {
    agentId: id,
    baseDir: evals.baseDir,
    secretsStore: evals.secretsStore,
    settings: evals.settings,
    passRunner: evals.passRunner,
  };
}

/**
 * X01b's middle phase: run the target spec's `evals` (when it has any and
 * the pin is not already a no-op). Throws the busy `PublishError` or
 * `EvalGateFailedError`; returns the result to report on success.
 */
async function runPublishGate(id: string, resolved: ResolvedPublish, evals: PublishEvalDeps): Promise<EvalGateResult | undefined> {
  const spec = resolved.spec;
  if (spec === undefined || resolved.alreadyPublished || (spec.evals?.length ?? 0) === 0) return undefined;
  if (evalGateBusy.has(id)) {
    throw new PublishError('Evals are already running for this agent', 409, 'LOUSHO_EVAL_GATE_BUSY');
  }
  evalGateBusy.add(id);
  let result: EvalGateResult;
  try {
    result = await (evals.runGates ?? runEvalGates)(spec, evalDepsFor(id, evals));
  } finally {
    evalGateBusy.delete(id);
  }
  if (!result.passed) {
    const failed = result.gates.filter((gate) => !gate.passed).length;
    await evals.alerts.add({
      kind: 'publish_failed',
      agentId: id,
      workspaceId: evals.workspaceId,
      title: `Publish of v${resolved.target} blocked by evals`,
      detail: `${failed} of ${result.gates.length} eval sets below the required pass rate`,
      payload: { version: resolved.target, result },
    });
    throw new EvalGateFailedError(result, resolved.target);
  }
  return result;
}

/** L14a's pin half: re-read meta under the lock, write the pointer, emit the event. */
async function pinVersion(
  id: string,
  resolved: ResolvedPublish,
  evalResult: EvalGateResult | undefined,
  deps: PublishDeps
): Promise<PublishResponse> {
  return withAgentLock(id, async () => {
    const meta = await deps.repo.readMeta(id);
    if (resolved.target === meta.publishedVersion) {
      return { publishedVersion: resolved.target, ...(evalResult !== undefined && { evalResult }) };
    }
    await deps.repo.writeMeta(id, { ...meta, publishedVersion: resolved.target, updatedAt: new Date().toISOString() });
    deps.events.publish({ type: 'agent.changed', agentId: id, reason: 'meta' });
    return { publishedVersion: resolved.target, ...(evalResult !== undefined && { evalResult }) };
  });
}

/**
 * Pins `opts.version` (or the working copy's freshly captured `publish`
 * version) as the agent's published version, after the spec's eval gates
 * pass when it declares any (X01b). Idempotent: pinning the already
 * published version writes nothing and emits no event.
 */
export async function publishAgent(
  id: string,
  opts: { version?: number },
  deps: PublishDeps
): Promise<PublishResponse> {
  const resolved = await withAgentLock(id, () => resolveTarget(id, opts, deps));
  const evalResult = deps.evals === undefined ? undefined : await runPublishGate(id, resolved, deps.evals);
  return pinVersion(id, resolved, evalResult, deps);
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

/** The app-level services the publish eval gate shares with the other pass callers. */
export interface PublishRouteServices {
  secretsStore: SecretsStore;
  settings: SettingsStore;
  alerts: AlertStore;
  /** Test seam forwarded to {@link PublishEvalDeps.runGates}. */
  runGates?: PublishEvalDeps['runGates'];
}

/**
 * `POST /agents/:id/publish` - `{ version?: number }` pins that version (or
 * the working copy's new `publish` version) and answers `{ publishedVersion,
 * evalResult? }`; a failing eval gate answers 409 `LOUSHO_EVAL_GATE_FAILED`
 * with the `EvalGateResult` as `details`, a concurrent gate 409
 * `LOUSHO_EVAL_GATE_BUSY`. Stores come from `workspaceOf(req)` (the workspace
 * seam); the gate's global services come from `services`.
 */
export function registerPublishRoutes(app: Express, services?: PublishRouteServices): void {
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
          ...(services === undefined
            ? {}
            : {
                evals: {
                  baseDir: ws.ref.root,
                  workspaceId: ws.ref.id,
                  secretsStore: services.secretsStore,
                  settings: services.settings,
                  passRunner: ws.passes,
                  alerts: services.alerts,
                  ...(services.runGates !== undefined && { runGates: services.runGates }),
                },
              }),
        });
        res.json(result);
      } catch (error) {
        if (error instanceof EvalGateFailedError) {
          // sendError's `{error, code, details}` shape plus the refused
          // version the dialog's `v<n>` copy needs.
          res.status(409).json({
            error: 'Eval gate failed',
            code: 'LOUSHO_EVAL_GATE_FAILED',
            version: error.version,
            details: error.result,
          } satisfies PublishGateFailure);
          return;
        }
        if (error instanceof PublishError) {
          sendError(res, error.status, error.message, error.code);
          return;
        }
        throw error;
      }
    })
  );
}
