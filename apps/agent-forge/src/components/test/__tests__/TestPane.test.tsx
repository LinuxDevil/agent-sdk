import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../ui/__tests__/render';
import type { AgentRunStatusPayload, ChatMessage } from '../../../../shared/wireTypes';

const state = vi.hoisted(() => ({
  runStatus: undefined as AgentRunStatusPayload | undefined,
  messages: [] as ChatMessage[],
}));

vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    chat: { sessionId: 's1', messages: state.messages },
    chatSessions: [],
    viewedChatSession: undefined,
    runStatus: state.runStatus,
    spans: [],
    chatActionError: undefined,
    startNewChat: vi.fn(),
    viewChatSession: vi.fn(),
    returnToLiveChat: vi.fn(),
    sendChatMessage: vi.fn(),
  }),
}));

import { TestPane } from '../TestPane';
import { useRunElapsed } from '../useRunElapsed';

const T0 = '2026-01-01T00:00:00.000Z';

function status(over: Partial<AgentRunStatusPayload>): AgentRunStatusPayload {
  return { agentId: 'agent', status: 'idle', updatedAt: T0, ...over };
}

/** jsdom has no scrolling; the thread scrolls itself to the newest message. */
function stubScroll() {
  Element.prototype.scrollTo = () => {};
}

describe('TestPane run bar', () => {
  beforeEach(() => {
    stubScroll();
    state.messages = [];
    state.runStatus = undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the status pill but no model, elapsed or trace link while idle', () => {
    const container = render(<TestPane />);
    const bar = container.querySelector('.test-run-bar')!;
    expect(bar.getAttribute('role')).toBe('group');
    expect(bar.getAttribute('aria-label')).toBe('Test run');
    expect(bar.querySelector('.status-pill')).not.toBeNull();
    expect(bar.querySelector('.test-run-model')).toBeNull();
    expect(bar.querySelector('.test-run-elapsed')).toBeNull();
    expect(bar.querySelector('.run-trace-link')).toBeNull();
  });

  it('shows the model and Open trace for a finished run, but no elapsed clock', () => {
    state.runStatus = status({ status: 'done', provider: 'openai/gpt-4o', traceId: 'trace-9' });
    const container = render(<TestPane />);
    const bar = container.querySelector('.test-run-bar')!;
    expect(bar.querySelector('.test-run-model')?.textContent).toBe('openai/gpt-4o');
    const link = bar.querySelector<HTMLAnchorElement>('.run-trace-link')!;
    expect(link.getAttribute('href')).toBe('#/traces/trace-9');
    expect(link.getAttribute('aria-label')).toBe('Open trace');
    expect(bar.querySelector('.test-run-elapsed')).toBeNull();
  });

  it('hides Open trace until the status carries a traceId', () => {
    state.runStatus = status({ status: 'running', provider: 'mock/mock-1' });
    const container = render(<TestPane />);
    expect(container.querySelector('.test-run-bar .run-trace-link')).toBeNull();
  });

  it('ticks the elapsed clock once a second while running, and stops when the run ends', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:01:05.000Z'));
    state.runStatus = status({ status: 'running', provider: 'mock/mock-1', updatedAt: T0 });
    const container = render(<TestPane />);
    const elapsed = () => container.querySelector('.test-run-elapsed');
    expect(elapsed()?.textContent).toBe('1:05');
    expect(elapsed()?.getAttribute('aria-label')).toBe('Running for 1:05');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(elapsed()?.textContent).toBe('1:07');

    state.runStatus = status({ status: 'done', provider: 'mock/mock-1', updatedAt: T0 });
    const idle = render(<TestPane />);
    expect(idle.querySelector('.test-run-elapsed')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(idle.querySelector('.test-run-elapsed')).toBeNull();
  });

  it('renders runActions at the right end of the run bar and aboveComposer above the composer', () => {
    state.runStatus = status({ status: 'running', provider: 'mock/mock-1', updatedAt: T0 });
    const container = render(
      <TestPane runActions={<button type="button">Stop</button>} aboveComposer={<div className="steer-slot">steer</div>} />,
    );
    const actions = container.querySelector('.test-run-actions')!;
    expect(actions.parentElement?.classList.contains('test-run-bar')).toBe(true);
    expect(actions.textContent).toBe('Stop');
    const slot = container.querySelector('.steer-slot')!;
    expect(slot.previousElementSibling?.classList.contains('chat-messages')).toBe(true);
    expect(slot.nextElementSibling?.classList.contains('chat-composer')).toBe(true);
  });
});

describe('useRunElapsed', () => {
  function Probe({ runStatus, now }: { runStatus: AgentRunStatusPayload | undefined; now?: () => number }) {
    const elapsed = useRunElapsed(runStatus, now);
    return <output className="elapsed-probe">{elapsed ?? 'none'}</output>;
  }

  it('formats m:ss from updatedAt with an injected clock, and is undefined when not running', () => {
    const now = () => Date.parse('2026-01-01T00:01:05.000Z');
    const running = render(<Probe runStatus={status({ status: 'running', updatedAt: T0 })} now={now} />);
    expect(running.querySelector('.elapsed-probe')?.textContent).toBe('1:05');

    for (const s of ['idle', 'done', 'paused', 'error'] as const) {
      const container = render(<Probe runStatus={status({ status: s, updatedAt: T0 })} now={now} />);
      expect(container.querySelector('.elapsed-probe')?.textContent).toBe('none');
    }
    expect(render(<Probe runStatus={undefined} now={now} />).querySelector('.elapsed-probe')?.textContent).toBe('none');
  });
});
