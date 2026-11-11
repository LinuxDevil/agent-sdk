/**
 * ApprovalCard's deadline line: "Decide within 4m 12s" for a paused tool
 * approval - visible text ticking each second, an aria-live announcement
 * re-spoken at most every fifteen, urgent styling under a minute.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';

const appState = vi.hoisted(() => ({
  approveAgent: vi.fn(async () => {}),
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { ApprovalCard } from '../ApprovalCard';

describe("ApprovalCard's deadline line", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows "Decide within" ticking each second, with a calmer aria-live announcement', () => {
    const container = render(
      <ApprovalCard toolName="demo-approval" args={{}} deadline={new Date(252_000).toISOString()} />
    );
    const line = container.querySelector('.deadline-line')!;
    const visible = line.querySelector('[aria-hidden="true"]')!;
    const spoken = line.querySelector('[aria-live="polite"]')!;
    expect(visible.textContent).toBe('Decide within 4m 12s');
    expect(spoken.textContent).toBe('Decide within 4m 12s');

    act(() => vi.advanceTimersByTime(1_000));
    // The visible text ticks; the announcement does not (15 s budget).
    expect(visible.textContent).toBe('Decide within 4m 11s');
    expect(spoken.textContent).toBe('Decide within 4m 12s');

    act(() => vi.advanceTimersByTime(15_000));
    expect(spoken.textContent).toBe('Decide within 3m 56s');
  });

  it('turns urgent under a minute and renders nothing without a deadline', () => {
    const urgent = render(<ApprovalCard toolName="t" args={{}} deadline={new Date(59_000).toISOString()} />);
    expect(urgent.querySelector('.deadline-line')?.classList.contains('urgent')).toBe(true);

    const none = render(<ApprovalCard toolName="t" args={{}} />);
    expect(none.querySelector('.deadline-line')).toBeNull();
  });
});
