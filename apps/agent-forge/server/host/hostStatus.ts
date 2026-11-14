/**
 * Host status (W11c): the `GET /workspaces/:ws/host` payload built from a
 * `WorkspaceHostSelector`, plus the `HostUnsupportedError` the bridge-mode
 * guards throw. `hostStatusOf` is pure - the route awaits
 * `hostSelector.ready()` first so a provisional 'bridge' selection has
 * already settled to its real mode.
 */
import type { WorkspaceRef } from '../../shared/workspace';
import type { HostState, HostStatus } from '../../shared/wireTypes';
import type { BridgeState } from './bridgeClient';
import type { WorkspaceHostSelector } from './hostSelector';

/** A feature the bridge does not carry yet (flows, breakpoints, time travel) refused with a clear message. */
export class HostUnsupportedError extends Error {
  /** Stable code the routes map to 409 `LOUSHO_HOST_UNSUPPORTED`. */
  // fallow-ignore-next-line unused-class-member -- read as err.code under instanceof narrowing in app.ts's error middleware; the member graph can't see the narrowing
  readonly code = 'LOUSHO_HOST_UNSUPPORTED';
}

/** `BridgeState` → `HostState`: idle/stopped start lazily on the next call, so they read 'ready'. */
function hostStateOf(state: BridgeState | undefined): HostState {
  switch (state) {
    case 'starting':
      return 'starting';
    case 'restarting':
      return 'restarting';
    case 'failed':
    case 'unsupported':
      return 'failed';
    default:
      // 'ready' | 'idle' | 'stopped' | undefined (in-process/read-only never spawn)
      return 'ready';
  }
}

/**
 * The status snapshot for `ref`'s workspace: the selection's mode/banner,
 * the bridge child's lifecycle state, and - only on a failed bridge - the
 * last 50 stderr lines for the "Show output" disclosure.
 */
export function hostStatusOf(ref: WorkspaceRef, selector: WorkspaceHostSelector, studioSdkVersion: string): HostStatus {
  const selection = selector.current();
  const state = selection.mode === 'bridge' ? hostStateOf(selector.client?.state) : 'ready';
  const status: HostStatus = {
    workspaceId: ref.id,
    mode: selection.mode,
    state,
    sdkVersion: selection.sdkVersion,
    studioSdkVersion,
    banner: selection.banner,
  };
  if (state === 'failed' && selector.client !== undefined) {
    const lines = selector.client.recentStderr().slice(-50);
    if (lines.length > 0) status.recentStderr = lines;
  }
  return status;
}
