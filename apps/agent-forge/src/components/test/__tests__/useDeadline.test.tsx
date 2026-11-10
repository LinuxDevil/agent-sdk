/**
 * useDeadline: the pause deadline's ticking countdown - '4m 12s', urgent
 * under a minute, expired at zero.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../../ui/__tests__/render';
import { useDeadline } from '../useDeadline';

function Probe({ deadline }: { deadline: string }) {
  const { remaining, urgent, expired } = useDeadline(deadline);
  return (
    <div>
      <span className="remaining">{remaining}</span>
      <span className="urgent">{String(urgent)}</span>
      <span className="expired">{String(expired)}</span>
    </div>
  );
}

describe('useDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats minutes and seconds, ticking down each second', () => {
    const container = render(<Probe deadline={new Date(252_000).toISOString()} />);
    expect(container.querySelector('.remaining')?.textContent).toBe('4m 12s');
    act(() => vi.advanceTimersByTime(1_000));
    expect(container.querySelector('.remaining')?.textContent).toBe('4m 11s');
    expect(container.querySelector('.urgent')?.textContent).toBe('false');
  });

  it('is urgent under a minute and expired at zero', () => {
    const container = render(<Probe deadline={new Date(59_400).toISOString()} />);
    expect(container.querySelector('.remaining')?.textContent).toBe('59s');
    expect(container.querySelector('.urgent')?.textContent).toBe('true');
    expect(container.querySelector('.expired')?.textContent).toBe('false');

    act(() => vi.advanceTimersByTime(60_000));
    expect(container.querySelector('.remaining')?.textContent).toBe('0s');
    expect(container.querySelector('.expired')?.textContent).toBe('true');
  });
});
