import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '../../ui/__tests__/render';
import { useStudioEvents } from '../useStudioEvents';
import { useAgentDocument } from '../useAgentDocument';
import type { AgentStore } from '../../persistence/AgentStore';
import type { StreamConnectionHandlers } from '../../runtime/runtimeClient';
import type { StudioEvent } from '../../../shared/wireTypes';

/**
 * `useStudioEvents` (src/state/useStudioEvents.ts) and the
 * `agent.changed` -> debounced agents-list refresh `useAgentDocument`
 * wires on top of it, against a mocked `runtimeClient.subscribeEvents`
 * (the socket itself is covered by server/__tests__/eventsWs.test.ts).
 */

const captured = vi.hoisted(() => ({
  calls: 0,
  onEvent: undefined as ((event: StudioEvent) => void) | undefined,
  connection: undefined as StreamConnectionHandlers | undefined,
  unsubscribe: vi.fn(),
}));

vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: {
    subscribeEvents: (onEvent: (event: StudioEvent) => void, connection?: StreamConnectionHandlers) => {
      captured.calls += 1;
      captured.onEvent = onEvent;
      captured.connection = connection;
      return captured.unsubscribe;
    },
  },
}));

function Probe({ onEvent }: { onEvent: (event: StudioEvent) => void }) {
  useStudioEvents(onEvent);
  return null;
}

function DocProbe({ store }: { store: AgentStore }) {
  useAgentDocument(store);
  return null;
}

const emit = (event: StudioEvent) => act(() => captured.onEvent?.(event));

beforeEach(() => {
  vi.useFakeTimers();
  captured.calls = 0;
  captured.onEvent = undefined;
  captured.connection = undefined;
  captured.unsubscribe.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useStudioEvents', () => {
  it('subscribes once and delivers each published event to the callback', () => {
    const spy = vi.fn();
    render(<Probe onEvent={spy} />);
    expect(captured.calls).toBe(1);
    const event: StudioEvent = { type: 'agent.changed', agentId: 'a1', reason: 'save' };
    emit(event);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(event);
  });

  it('resubscribes 2 s after the socket is lost', () => {
    render(<Probe onEvent={vi.fn()} />);
    act(() => captured.connection?.onLost?.());
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(captured.calls).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(captured.calls).toBe(2);
  });

  it('unsubscribes on unmount so a stale listener receives nothing', () => {
    render(<Probe onEvent={vi.fn()} />);
    cleanup();
    expect(captured.unsubscribe).toHaveBeenCalled();
  });
});

describe('agent.changed -> agents list refresh', () => {
  it('an agent.changed triggers one refresh after the debounce', async () => {
    const store: AgentStore = {
      list: vi.fn(async () => []),
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    render(<DocProbe store={store} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(store.list).toHaveBeenCalledTimes(1); // the mount-time load

    // Two agent.changed events inside one 300 ms window coalesce.
    emit({ type: 'agent.changed', agentId: 'a1', reason: 'save' });
    emit({ type: 'agent.changed', agentId: 'a2', reason: 'version' });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(store.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(store.list).toHaveBeenCalledTimes(2);

    // Other StudioEvent types don't touch the agents list.
    emit({ type: 'inbox.count', count: 3 });
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(store.list).toHaveBeenCalledTimes(2);
  });
});
