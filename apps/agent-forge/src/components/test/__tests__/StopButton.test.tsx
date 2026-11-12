import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, rerender } from '../../../ui/__tests__/render';
import type { AgentRunStatusPayload } from '../../../../shared/wireTypes';

const state = vi.hoisted(() => ({
  runStatus: undefined as AgentRunStatusPayload | undefined,
  stopAgent: vi.fn(async () => {}),
}));

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    runStatus: state.runStatus,
    stopAgent: state.stopAgent,
  }),
}));

import { StopButton } from '../StopButton';

const T0 = '2026-01-01T00:00:00.000Z';

function status(over: Partial<AgentRunStatusPayload>): AgentRunStatusPayload {
  return { agentId: 'agent', status: 'idle', updatedAt: T0, ...over };
}

function button(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('.test-run-stop');
}

describe('StopButton', () => {
  beforeEach(() => {
    state.runStatus = undefined;
    state.stopAgent = vi.fn(async () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['idle', 'done', 'stopped', 'error'] as const)('is hidden while the run is %s', (s) => {
    state.runStatus = status({ status: s });
    const container = render(<StopButton />);
    expect(button(container)).toBeNull();
  });

  it('is hidden before the first status push arrives', () => {
    const container = render(<StopButton />);
    expect(button(container)).toBeNull();
  });

  it.each(['running', 'paused'] as const)('shows a Stop button while the run is %s', (s) => {
    state.runStatus = status({ status: s });
    const container = render(<StopButton />);
    const el = button(container)!;
    expect(el).not.toBeNull();
    expect(el.textContent).toContain('Stop');
    expect(el.disabled).toBe(false);
    expect(el.querySelector('svg')).not.toBeNull();
  });

  it('calls stopAgent when clicked', async () => {
    state.runStatus = status({ status: 'running' });
    const container = render(<StopButton />);
    await act(async () => {
      button(container)!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(state.stopAgent).toHaveBeenCalledTimes(1);
  });

  it('shows "Stopping…" and disables itself while the abort request is in flight', async () => {
    let release!: () => void;
    state.stopAgent = vi.fn(
      (): Promise<void> =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    state.runStatus = status({ status: 'running' });
    const container = render(<StopButton />);

    act(() => {
      button(container)!.click();
    });
    const busy = button(container)!;
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).toContain('Stopping…');

    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(button(container)!.disabled).toBe(false);
    expect(button(container)!.textContent).toContain('Stop');
  });

  it('surfaces a failed abort as an inline error and stays clickable', async () => {
    state.stopAgent = vi.fn(async (): Promise<void> => {
      throw new Error('boom');
    });
    state.runStatus = status({ status: 'paused' });
    const container = render(<StopButton />);
    await act(async () => {
      button(container)!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('.run-error')?.textContent).toBe('boom');
    expect(button(container)!.disabled).toBe(false);
  });

  it('hides again when the status push flips to stopped', () => {
    state.runStatus = status({ status: 'running' });
    const container = render(<StopButton />);
    expect(button(container)).not.toBeNull();
    state.runStatus = status({ status: 'stopped', abortReason: 'user' });
    rerender(<StopButton />);
    expect(button(container)).toBeNull();
  });
});
