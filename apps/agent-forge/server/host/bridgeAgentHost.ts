/**
 * BridgeAgentHost: the `AgentHost` that runs a workspace's specs through
 * the project's own installed SDK (PLAN §19.4). Every method is a bridge
 * request; every push becomes a `HostEvent` on the run's `onEvent`.
 *
 * Run correlation: `start` gets a `runId` back, subscribes `onPush` to it,
 * and the subscription lives until a terminal push (`run.settled` with a
 * non-`awaiting-approval` finish, or `run.failed`) - an approval pause
 * keeps it so the continuation's events land on the same `onEvent`.
 *
 * Read-only workspaces (selector rows 3-5): every method throws
 * `HostReadOnlyError` except `catalog` (the in-process fallback) and
 * `dispose`.
 */
import type { Message } from 'lousho';
import { BridgeError, type BridgeClient } from './bridgeClient';
import { providerEnv, secretsFor, toHostEvent } from './bridgeMapping';
import type { WorkspaceSdk } from './workspaceSdk';
import { HostRunNotActiveError, type AgentHost, type HostCatalog, type HostRun, type HostRunInput, type HostRunResult, type HostSteerResult } from './agentHost';
import type { HostSelection } from './hostSelector';
import type { SecretsStore } from '../secretsStore';

/** A host call refused because the workspace's SDK cannot host runs (selector read-only rows). */
export class HostReadOnlyError extends Error {
  /** Stable code RunManager/routes map to a 4xx. */
  // fallow-ignore-next-line unused-class-member -- read as error.code under instanceof narrowing once W11c's routes land; the graph only sees the throw today
  readonly code = 'LOUSHO_WORKSPACE_READ_ONLY';
}

/** A `start` that the bridge refused; `code` is the bridge's error code (W11c maps `LOUSHO_BRIDGE_*` to 503). */
export class HostStartError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'HostStartError';
  }
}

/** `BridgeAgentHost` deps: the transport, the workspace's secret store, and the selector's async decision. */
export interface BridgeAgentHostDeps {
  secretsStore: SecretsStore;
  /** The selector's `ready()` - resolves the final mode/banner after the handshake. */
  ready: () => Promise<HostSelection>;
  /** Catalog fallback for read-only workspaces (the in-process host's). */
  fallbackCatalog: () => Promise<HostCatalog>;
  /** The SDK found on disk, for `sdkVersion` before the handshake lands. */
  sdk: WorkspaceSdk;
}

const READ_ONLY_MESSAGE = 'This workspace is read-only.';

/** Error codes the bridge answers for a run/approval that is gone - mapped to `HostRunNotActiveError` (409). */
const NOT_ACTIVE_CODES = new Set(['LOUSHO_NO_ACTIVE_RUN', 'LOUSHO_BRIDGE_RUN_NOT_FOUND', 'LOUSHO_APPROVAL_NOT_FOUND']);

export class BridgeAgentHost implements AgentHost {
  readonly kind = 'bridge';
  private readonly unsubscribers = new Map<string, () => void>();
  private catalogCache: { hash: string; catalog: HostCatalog } | undefined;

  constructor(
    private readonly client: BridgeClient,
    private readonly deps: BridgeAgentHostDeps
  ) {}

  /** The bridge SDK's version once hello lands, else the on-disk SDK's. */
  get sdkVersion(): string {
    return this.client.hello?.sdkVersion ?? this.deps.sdk.version;
  }

  async start(input: HostRunInput): Promise<HostRun> {
    await this.readyOrThrow();
    const secrets = secretsFor(input.spec, this.deps.secretsStore);
    const env = providerEnv(this.deps.secretsStore);
    const base = {
      agentId: input.agentId,
      spec: input.spec,
      sessionId: input.sessionId,
      ...(input.captureContent !== undefined && { captureContent: input.captureContent }),
      ...(secrets !== undefined && { secrets }),
      ...(env !== undefined && { env }),
    };
    let started: { runId: string; modelLabel: string };
    try {
      if (typeof input.input === 'string') {
        started = await this.client.request('run', { ...base, input: input.input });
      } else {
        const messages = asMessages(input.input);
        started = await this.client.request('chat', { ...base, messages });
      }
    } catch (error) {
      if (error instanceof BridgeError) throw new HostStartError(error.message, error.code, error.details);
      throw error;
    }
    const runId = started.runId;
    this.unsubscribers.set(
      runId,
      this.client.onPush(runId, (push) => {
        input.onEvent(toHostEvent(push));
        if (push.event === 'run.failed' || (push.event === 'run.settled' && (push.data as HostRunResult).finishReason !== 'awaiting-approval')) {
          this.unsubscribers.get(runId)?.();
          this.unsubscribers.delete(runId);
        }
      })
    );
    return { runId, modelLabel: started.modelLabel };
  }

  async steer(runId: string, message: string): Promise<HostSteerResult> {
    await this.readyOrThrow();
    try {
      return await this.client.request('steer', { runId, message });
    } catch (error) {
      throw asNotActive(error);
    }
  }

  async abort(runId: string, reason?: string): Promise<void> {
    await this.readyOrThrow();
    try {
      const result = await this.client.request('abort', { runId, ...(reason !== undefined && { reason }) });
      if (result.state === 'discarded') this.dropRun(runId);
    } catch (error) {
      throw asNotActive(error);
    }
  }

  async resolveApproval(runId: string, approvalId: string, decision: { approved: boolean; note?: string }): Promise<void> {
    await this.readyOrThrow();
    try {
      await this.client.request('resolveApproval', { runId, approvalId, approved: decision.approved, ...(decision.note !== undefined && { note: decision.note }) });
    } catch (error) {
      throw asNotActive(error);
    }
  }

  async answerQuestion(runId: string, questionId: string, answer: string): Promise<void> {
    await this.readyOrThrow();
    try {
      await this.client.request('answerQuestion', { runId, questionId, answer });
    } catch (error) {
      throw asNotActive(error);
    }
  }

  async catalog(): Promise<HostCatalog> {
    const selection = await this.deps.ready();
    if (selection.mode === 'read-only') return this.deps.fallbackCatalog();
    const hash = this.client.hello?.catalogHash;
    if (hash !== undefined && this.catalogCache?.hash === hash) return this.catalogCache.catalog;
    const catalog = await this.client.request('catalog', {});
    if (hash !== undefined) this.catalogCache = { hash, catalog };
    return catalog;
  }

  async dispose(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    await this.client.stop();
  }

  private async readyOrThrow(): Promise<HostSelection> {
    const selection = await this.deps.ready();
    if (selection.mode === 'read-only') {
      throw new HostReadOnlyError(selection.banner?.text ?? READ_ONLY_MESSAGE);
    }
    return selection;
  }

  private dropRun(runId: string): void {
    this.unsubscribers.get(runId)?.();
    this.unsubscribers.delete(runId);
  }
}

/**
 * `chat`'s `messages` param: `Message[]` passes through (`[]` continues a
 * forked checkpoint with no new input); `ContentPart[]` and anything else
 * are caller bugs - the in-process host's `toMessages` wrapping has no
 * bridge equivalent, so they fail loudly here instead of sending the
 * bridge a params shape its schema rejects.
 */
function asMessages(input: unknown): Message[] {
  if (Array.isArray(input) && (input.length === 0 || 'role' in (input[0] as object))) {
    return input as Message[];
  }
  throw new TypeError('BridgeAgentHost chat input must be Message[]');
}

function asNotActive(error: unknown): unknown {
  if (error instanceof BridgeError && NOT_ACTIVE_CODES.has(error.code)) {
    return new HostRunNotActiveError(error.message);
  }
  return error;
}
