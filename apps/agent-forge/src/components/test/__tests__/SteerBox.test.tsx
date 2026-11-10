import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../ui/__tests__/render';
import type { AgentRunStatusPayload, SteerInfo } from '../../../../shared/wireTypes';

const state = vi.hoisted(() => ({
  runStatus: undefined as AgentRunStatusPayload | undefined,
  steerRun: vi.fn(),
}));

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    runStatus: state.runStatus,
    steerRun: state.steerRun,
  }),
}));

import { SteerBox } from '../SteerBox';

const T0 = '2026-01-01T00:00:00.000Z';

function status(over: Partial<AgentRunStatusPayload>): AgentRunStatusPayload {
  return { agentId: 'agent', status: 'idle', updatedAt: T0, ...over };
}

function steerItem(over: Partial<SteerInfo>): SteerInfo {
  return { id: 's1', message: 'use Paris', at: T0, delivery: 'queued', mode: 'queued', ...over };
}

function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(el: HTMLTextAreaElement, k: string, init: KeyboardEventInit = {}) {
  act(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })));
}

function click(el: Element) {
  act(() => (el as HTMLElement).click());
}

const textarea = (container: HTMLDivElement) => container.querySelector<HTMLTextAreaElement>('.steer-input')!;
const sendButton = (container: HTMLDivElement) => container.querySelector<HTMLButtonElement>('.steer-send')!;

describe('SteerBox', () => {
  beforeEach(() => {
    state.runStatus = undefined;
    state.steerRun = vi.fn().mockResolvedValue({ id: 's1', applied: 'queued' });
  });

  it('renders nothing while idle with no steering history', () => {
    const container = render(<SteerBox />);
    expect(container.querySelector('.steer-box')).toBeNull();

    state.runStatus = status({ status: 'done' });
    const done = render(<SteerBox />);
    expect(done.querySelector('.steer-box')).toBeNull();
  });

  it('shows the form only while the run is running', () => {
    state.runStatus = status({ status: 'running', provider: 'mock/mock-1' });
    const container = render(<SteerBox />);
    expect(container.querySelector('.steer-label')?.textContent).toBe('Message the running agent');
    expect(textarea(container).rows).toBe(2);
    expect(textarea(container).maxLength).toBe(3000);
    expect(sendButton(container).textContent).toContain('Send to run');
    // No steering history yet -> no list.
    expect(container.querySelector('.steer-list')).toBeNull();

    // Paused/done hide the form; the list alone stays when there is history.
    state.runStatus = status({
      status: 'done',
      steering: [steerItem({ delivery: 'delivered' })],
    });
    const after = render(<SteerBox />);
    expect(after.querySelector('.steer-input')).toBeNull();
    expect(after.querySelector('.steer-list')).not.toBeNull();
  });

  it('sends the trimmed draft through steerRun and clears the box', async () => {
    state.runStatus = status({ status: 'running' });
    const container = render(<SteerBox />);
    type(textarea(container), '  use Paris instead  ');
    click(sendButton(container));
    await act(async () => {});
    expect(state.steerRun).toHaveBeenCalledWith('use Paris instead');
    expect(textarea(container).value).toBe('');
  });

  it('Enter sends, Shift+Enter inserts a newline', async () => {
    state.runStatus = status({ status: 'running' });
    const container = render(<SteerBox />);
    type(textarea(container), 'first line');
    key(textarea(container), 'Enter', { shiftKey: true });
    await act(async () => {});
    expect(state.steerRun).not.toHaveBeenCalled();

    type(textarea(container), 'first line\nsecond line');
    key(textarea(container), 'Enter');
    await act(async () => {});
    expect(state.steerRun).toHaveBeenCalledWith('first line\nsecond line');
  });

  it('shows an inline alert when steerRun rejects, keeping the draft', async () => {
    state.steerRun = vi.fn().mockRejectedValue(new Error("Nothing is running, so there is nothing to steer."));
    state.runStatus = status({ status: 'running' });
    const container = render(<SteerBox />);
    type(textarea(container), 'too late');
    key(textarea(container), 'Enter');
    await act(async () => {});
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('Nothing is running, so there is nothing to steer.');
    expect(textarea(container).value).toBe('too late');
  });

  it('lists steering items with their delivery badges and the undelivered note', () => {
    state.runStatus = status({
      status: 'done',
      steering: [
        steerItem({ id: 'a', message: 'queued msg', delivery: 'queued' }),
        steerItem({ id: 'b', message: 'delivered msg', delivery: 'delivered' }),
        steerItem({ id: 'c', message: 'lost msg', delivery: 'undelivered' }),
      ],
    });
    const container = render(<SteerBox />);
    const items = [...container.querySelectorAll('.steer-item')];
    expect(items).toHaveLength(3);
    expect(items.map((li) => li.querySelector('.status-badge-label')?.textContent)).toEqual([
      'Queued',
      'Delivered',
      'Undelivered',
    ]);
    expect(items[0].querySelector('.steer-item-message')?.textContent).toBe('queued msg');
    expect(items[2].querySelector('.steer-item-note')?.textContent).toBe(
      'The run ended before this message was delivered.'
    );
    expect(items[0].querySelector('.steer-item-note')).toBeNull();
  });

  it('shows the character counter only past 2500 characters', () => {
    state.runStatus = status({ status: 'running' });
    const container = render(<SteerBox />);
    expect(container.querySelector('.steer-count')).toBeNull();
    type(textarea(container), 'x'.repeat(2501));
    expect(container.querySelector('.steer-count')?.textContent).toBe('2501/3000');
  });
});
