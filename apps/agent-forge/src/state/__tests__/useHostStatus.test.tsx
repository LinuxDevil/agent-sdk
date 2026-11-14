import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '../../ui/__tests__/render';
import { useHostStatus, type HostStatusState } from '../useHostStatus';
import type { HostStatus, StudioEvent } from '../../../shared/wireTypes';
import type { StreamConnectionHandlers } from '../../runtime/runtimeClient';

/**
 * `useHostStatus` against a mocked `runtimeClient`: the initial
 * `GET /workspaces/:ws/host`, the workspace-bound `host.status` event
 * subscription, and the restart action's busy/error states.
 */

const captured = vi.hoisted(() => ({
  hostStatus: vi.fn(),
  restartHost: vi.fn(),
  subscribeEvents: vi.fn(),
  onEvent: undefined as ((event: StudioEvent) => void) | undefined,
  connection: undefined as StreamConnectionHandlers | undefined,
  unsubscribe: vi.fn(),
}));

vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: {
    hostStatus: captured.hostStatus,
    restartHost: captured.restartHost,
    forWorkspace: () => ({
      subscribeEvents: (onEvent: (event: StudioEvent) => void, connection?: StreamConnectionHandlers) => {
        captured.subscribeEvents();
        captured.onEvent = onEvent;
        captured.connection = connection;
        return captured.unsubscribe;
      },
      hostStatus: captured.hostStatus,
    }),
  },
}));

function status(over: Partial<HostStatus> = {}): HostStatus {
  return {
    workspaceId: 'ws-abc123',
    mode: 'in-process',
    state: 'ready',
    sdkVersion: '1.0.0',
    studioSdkVersion: '1.0.0',
    banner: null,
    ...over,
  };
}

/** Mounts the hook and exposes its latest return value. */
function Probe({ ws }: { ws: string | undefined }): { current: HostStatusState | undefined } {
  const box = { current: undefined as HostStatusState | undefined };
  function Inner(): null {
    box.current = useHostStatus(ws);
    return null;
  }
  render(<Inner />);
  return box;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useHostStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onEvent = undefined;
    captured.connection = undefined;
    cleanup();
  });

  it('fetches the status once and subscribes to that workspace\'s events', async () => {
    captured.hostStatus.mockResolvedValue(status());
    const box = Probe({ ws: 'ws-abc123' });
    await flush();
    expect(captured.hostStatus).toHaveBeenCalledWith('ws-abc123');
    expect(captured.subscribeEvents).toHaveBeenCalledTimes(1);
    expect(box.current?.status).toEqual(status());
  });

  it('does nothing without a workspace id', async () => {
    Probe({ ws: undefined });
    await flush();
    expect(captured.hostStatus).not.toHaveBeenCalled();
    expect(captured.subscribeEvents).not.toHaveBeenCalled();
  });

  it('applies host.status events for its workspace and ignores others', async () => {
    captured.hostStatus.mockResolvedValue(status());
    const box = Probe({ ws: 'ws-abc123' });
    await flush();
    const next = status({ mode: 'bridge', state: 'failed', banner: { tone: 'danger', text: 'crashed', action: 'restart' } });
    act(() => captured.onEvent?.({ type: 'host.status', payload: next }));
    expect(box.current?.status).toEqual(next);
    act(() =>
      captured.onEvent?.({ type: 'host.status', payload: status({ workspaceId: 'ws-other00' }) })
    );
    expect(box.current?.status).toEqual(next);
  });

  it('re-reads the REST status when the socket is lost', async () => {
    captured.hostStatus.mockResolvedValue(status());
    Probe({ ws: 'ws-abc123' });
    await flush();
    captured.hostStatus.mockResolvedValue(status({ mode: 'bridge' }));
    act(() => captured.connection?.onLost?.());
    await flush();
    expect(captured.hostStatus).toHaveBeenCalledTimes(2);
  });

  it('restart() posts and applies the returned status, toggling restarting', async () => {
    captured.hostStatus.mockResolvedValue(status({ mode: 'bridge', state: 'failed' }));
    const settled = status({ mode: 'bridge', state: 'ready' });
    captured.restartHost.mockImplementation(async () => {
      await Promise.resolve();
      return settled;
    });
    const box = Probe({ ws: 'ws-abc123' });
    await flush();
    let promise: Promise<void> | undefined;
    act(() => {
      promise = box.current!.restart();
    });
    expect(box.current?.restarting).toBe(true);
    await act(async () => {
      await promise;
    });
    expect(captured.restartHost).toHaveBeenCalledWith('ws-abc123');
    expect(box.current?.restarting).toBe(false);
    expect(box.current?.status).toEqual(settled);
  });

  it('restart() surfaces the server message as restartError', async () => {
    captured.hostStatus.mockResolvedValue(status({ mode: 'in-process' }));
    captured.restartHost.mockRejectedValue(new Error('Only a project bridge can be restarted.'));
    const box = Probe({ ws: 'ws-abc123' });
    await flush();
    await act(async () => {
      await box.current!.restart();
    });
    expect(box.current?.restartError).toBe('Only a project bridge can be restarted.');
    expect(box.current?.restarting).toBe(false);
  });

  it('unsubscribes on unmount', async () => {
    captured.hostStatus.mockResolvedValue(status());
    Probe({ ws: 'ws-abc123' });
    await flush();
    cleanup();
    expect(captured.unsubscribe).toHaveBeenCalled();
  });
});
