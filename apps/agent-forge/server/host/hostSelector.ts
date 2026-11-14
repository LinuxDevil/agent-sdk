/**
 * WorkspaceHostSelector: picks a workspace's `AgentHost` once, from disk,
 * then finishes the decision after the `hello` handshake (PLAN §19.4
 * "Selection per workspace").
 *
 * Synchronous part (`createWorkspaceContext` cannot await): `findWorkspaceSdk`
 * decides rows 1-2 immediately - no SDK, or an unbuilt SDK checkout, means
 * Studio's in-process host and no child process is ever spawned. Rows 3-7
 * need the handshake, so the selector exposes a provisional `bridge`
 * selection and `ready()` settles it.
 *
 * `LOUSHO_OBSERVE_PROJECT = ref.id` in the child env makes the project's
 * runs group under this workspace on the observe daemon (the daemon's
 * default project is the package name, which would not match); the studio
 * token and listener vars are stripped so project code never sees them.
 */
import type { WorkspaceRef } from '../../shared/workspace';
import { BRIDGE_PROTOCOL_VERSION } from '@linuxdevil/lousho';
import { observeTarget } from '../observeProxy';
import type { HostBanner, HostMode } from '../../shared/wireTypes';
import { BridgeClient, BridgeError, type BridgeClientOptions, type BridgeState } from './bridgeClient';
import { BridgeAgentHost } from './bridgeAgentHost';
import { InProcessAgentHost } from './inProcessAgentHost';
import { MIN_BRIDGE_SDK_VERSION } from './sdkCompat';
import { findWorkspaceSdk, type WorkspaceSdk } from './workspaceSdk';
import type { AgentHost } from './agentHost';
import type { SecretsStore } from '../secretsStore';

/** Where a workspace's runs execute, plus the banner explaining it. */
export interface HostSelection {
  mode: HostMode;
  /** The SDK found on disk (bridge/read-only rows); absent in-process. */
  sdk?: WorkspaceSdk;
  /** The SDK version runs execute under, or null before it is known. */
  sdkVersion: string | null;
  banner: HostBanner | null;
  /** The bridge protocol the SDK answered with (rows 4-7 only). */
  protocol?: number;
  /** The spec versions the SDK's bridge accepts (rows 4-7 only). */
  specVersions?: readonly number[];
}

/** Everything the selector needs that the workspace context cannot build synchronously. */
export interface SelectHostDeps {
  /** Builds the in-process host from this workspace's stores (rows 1-2). */
  inProcess: () => InProcessAgentHost;
  secretsStore: SecretsStore;
  /** The observe collector (W12's CollectorManager; env fallback until then). */
  collector: () => { url: string; token?: string };
  /** Studio's own SDK version, for `hello.client` is implicit; banners name it. */
  studioVersion: string;
  /** Test hooks forwarded to `BridgeClient` (fake spawn, short timeouts). */
  clientOptions?: Partial<BridgeClientOptions>;
  /** Test hooks: Node flags before the bin (e.g. `--import` a provider preload). */
  nodeArgs?: readonly string[];
  /** Test hooks: merged last into the child env (e.g. `SCRIPTED_TURNS`). */
  extraEnv?: Readonly<Record<string, string>>;
}

const INFO_NO_SDK = (v: string): HostBanner => ({
  tone: 'info',
  text: `This project has no @linuxdevil/lousho installed. Runs use Studio's built-in SDK ${v}.`,
});
const INFO_UNBUILT = (v: string): HostBanner => ({
  tone: 'info',
  text: `This SDK checkout is not built, so runs use Studio's built-in SDK ${v}. Run npm run build to use it.`,
});
const WARNING_OLD_SDK = (): HostBanner => ({
  tone: 'warning',
  text: `Update @linuxdevil/lousho in this project to ${MIN_BRIDGE_SDK_VERSION} or later to edit agents here.`,
});
const WARNING_NEWER_SDK = (v: string): HostBanner => ({
  tone: 'warning',
  text: `This project's @linuxdevil/lousho ${v} is newer than this Studio understands. Update Studio to edit agents here.`,
});
const DANGER_CRASHED = (): HostBanner => ({
  tone: 'danger',
  text: "This project's agent process keeps stopping. Check the Studio terminal for its output, then restart it.",
  action: 'restart',
});

/**
 * The pre-W12 collector: the observe daemon Studio itself is configured
 * against (`LOUSHO_OBSERVE_URL`, default loopback :7777) plus its bearer
 * when set. W12's CollectorManager replaces this behind the same
 * `() => { url, token? }` shape.
 */
export function envCollector(): { url: string; token?: string } {
  const token = process.env.LOUSHO_OBSERVE_TOKEN;
  return { url: observeTarget(), ...(token ? { token } : {}) };
}

/** Env the bridge child gets: observe reporting + workspace identity, minus Studio's own secrets/listeners. */
function bridgeEnv(ref: WorkspaceRef, collector: { url: string; token?: string }, extra?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOUSHO_OBSERVE: collector.url,
    LOUSHO_OBSERVE_PROJECT: ref.id,
    LOUSHO_BRIDGE: '1',
  };
  if (collector.token) env.LOUSHO_OBSERVE_TOKEN = collector.token;
  else delete env.LOUSHO_OBSERVE_TOKEN;
  for (const key of ['LOUSHO_STUDIO_TOKEN', 'LOUSHO_STUDIO_ALLOWED_ORIGINS', 'PORT', 'HOST', 'BASE_DIR', 'NO_STATIC', 'STATIC_DIR']) {
    delete env[key];
  }
  return { ...env, ...extra };
}

/** One workspace's host decision: in-process, bridge, or read-only. */
export class WorkspaceHostSelector {
  /** The host RunManager uses - fixed for the context's life. */
  readonly host: AgentHost;
  /** RunManager's `observe` flag: true only in-process (a bridge reports to the daemon itself). */
  readonly reportsToObserve: boolean;
  /** The bridge client on rows 3-7, for W11c's state and stderr. */
  readonly client?: BridgeClient;

  private readonly sdk: WorkspaceSdk | undefined;
  private readonly inProcessHost?: InProcessAgentHost;
  private fallbackHost: InProcessAgentHost | undefined;
  private readonly listeners = new Set<(selection: HostSelection) => void>();
  private selection: HostSelection;
  private readyPromise: Promise<HostSelection> | undefined;

  constructor(ref: WorkspaceRef, deps: SelectHostDeps) {
    this.sdk = findWorkspaceSdk(ref.root);
    if (this.sdk === undefined) {
      // Row 1: no SDK on disk - Studio's own SDK runs everything.
      this.inProcessHost = deps.inProcess();
      this.host = this.inProcessHost;
      this.reportsToObserve = true;
      this.selection = { mode: 'in-process', sdkVersion: deps.studioVersion, banner: INFO_NO_SDK(deps.studioVersion) };
      return;
    }
    if (this.sdk.source === 'self' && !this.sdk.built) {
      // Row 2: the SDK checkout itself, unbuilt - same fallback, different hint.
      this.inProcessHost = deps.inProcess();
      this.host = this.inProcessHost;
      this.reportsToObserve = true;
      this.selection = { mode: 'in-process', sdkVersion: deps.studioVersion, banner: INFO_UNBUILT(deps.studioVersion) };
      return;
    }
    // Rows 3-7: a BridgeAgentHost over a BridgeClient; `ready()` settles which.
    const client = new BridgeClient(
      {
        command: process.execPath,
        args: [...(deps.nodeArgs ?? []), this.sdk.binPath, 'bridge'],
        cwd: ref.root,
        env: bridgeEnv(ref, deps.collector(), deps.extraEnv),
        label: ref.name,
      },
      { clientVersion: deps.studioVersion, ...deps.clientOptions }
    );
    this.client = client;
    this.reportsToObserve = false;
    const bridgeHost = new BridgeAgentHost(client, {
      secretsStore: deps.secretsStore,
      ready: () => this.ready(),
      fallbackCatalog: () => (this.fallbackHost ??= deps.inProcess()).catalog(),
      sdk: this.sdk,
    });
    this.host = bridgeHost;
    // Provisional: the handshake has not run; W11c shows 'starting'.
    this.selection = { mode: 'bridge', sdk: this.sdk, sdkVersion: this.sdk.version, banner: null };
    client.onStateChange((state) => this.onClientState(state));
  }

  /** The current selection snapshot (pre-handshake rows 3-7 read `bridge`/`sdk.version`). */
  current(): HostSelection {
    return this.selection;
  }

  /** Memoized handshake + row check; in-process resolves at once. */
  ready(): Promise<HostSelection> {
    if (this.inProcessHost !== undefined) return Promise.resolve(this.selection);
    this.readyPromise ??= this.finishHandshake(false);
    return this.readyPromise;
  }

  /** Clears the memo, `client.restart()`, and re-runs the row check (W11c's Restart). */
  // fallow-ignore-next-line unused-class-member -- W11c's status banner restart action consumes it; W11b only constructs the selector
  restart(): Promise<HostSelection> {
    if (this.client === undefined) return Promise.resolve(this.selection);
    this.readyPromise = this.finishHandshake(true);
    return this.readyPromise;
  }

  /** Subscribes to selection changes (W11c turns them into `host.status` events). */
  onChange(listener: (selection: HostSelection) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -- handshake rows ---------------------------------------------------------

  private async finishHandshake(useRestart: boolean): Promise<HostSelection> {
    const client = this.client;
    if (client === undefined) return this.selection;
    try {
      const hello = useRestart ? await client.restart() : await client.start();
      // Rows 4-5: a hello that cannot serve v2 specs or protocol 1 is read-only.
      // The handshake's version is the SDK that answered - record it over the disk read.
      if (!hello.specVersions.includes(2)) {
        await client.stop();
        return this.settle({ mode: 'read-only', banner: WARNING_OLD_SDK(), sdkVersion: hello.sdkVersion, protocol: hello.protocol, specVersions: hello.specVersions });
      }
      if (hello.protocol !== BRIDGE_PROTOCOL_VERSION) {
        await client.stop();
        return this.settle({ mode: 'read-only', banner: WARNING_NEWER_SDK(hello.sdkVersion), sdkVersion: hello.sdkVersion, protocol: hello.protocol, specVersions: hello.specVersions });
      }
      // Row 6.
      return this.settle({ mode: 'bridge', banner: null, sdkVersion: hello.sdkVersion, protocol: hello.protocol, specVersions: hello.specVersions });
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'LOUSHO_BRIDGE_UNSUPPORTED') {
        // Row 3: no hello ever answered - the SDK version is unknown.
        await client.stop();
        return this.settle({ mode: 'read-only', banner: WARNING_OLD_SDK(), sdkVersion: null });
      }
      // Row 7: transport-level failure - the host stays 'bridge' with a restart banner.
      return this.settle({ mode: 'bridge', banner: DANGER_CRASHED() });
    }
  }

  /** A later crash flips a healthy bridge to the restart banner; recovery clears it. */
  private onClientState(state: BridgeState): void {
    if (this.selection.mode !== 'bridge') return;
    if (state === 'failed' && this.selection.banner === null) {
      this.settle({ mode: 'bridge', banner: DANGER_CRASHED() });
    } else if (state === 'ready' && this.selection.banner?.action === 'restart') {
      this.settle({ mode: 'bridge', banner: null });
    }
  }

  private settle(patch: { mode: HostMode; banner: HostBanner | null; sdkVersion?: string | null; protocol?: number; specVersions?: readonly number[] }): HostSelection {
    const next: HostSelection = {
      mode: patch.mode,
      sdk: this.sdk,
      sdkVersion: patch.sdkVersion !== undefined ? patch.sdkVersion : this.selection.sdkVersion,
      banner: patch.banner,
      protocol: patch.protocol ?? this.selection.protocol,
      specVersions: patch.specVersions ?? this.selection.specVersions,
    };
    const before = this.selection;
    const unchanged =
      before.mode === next.mode &&
      before.sdkVersion === next.sdkVersion &&
      before.protocol === next.protocol &&
      before.banner?.tone === next.banner?.tone &&
      before.banner?.text === next.banner?.text &&
      before.banner?.action === next.banner?.action &&
      (before.specVersions === undefined || next.specVersions === undefined || before.specVersions.join() === next.specVersions.join());
    if (unchanged) return before;
    this.selection = next;
    for (const listener of this.listeners) listener(this.selection);
    return this.selection;
  }
}
