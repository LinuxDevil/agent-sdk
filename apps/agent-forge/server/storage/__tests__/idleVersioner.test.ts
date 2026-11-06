import { describe, it, expect, vi } from 'vitest';
import { IDLE_VERSION_DELAY_MS, IdleVersioner } from '../idleVersioner';

/**
 * A fake `setTimer`/`clearTimer` pair for `IdleVersioner`: `setTimer`
 * records the callback and returns the recorded entry as the handle;
 * `fire(handle)` runs it (the way a real timer would after `ms`).
 */
function fakeClock() {
  const scheduled = new Map<unknown, { fn: () => void; ms: number }>();
  const setTimer = vi.fn((fn: () => void, ms: number) => {
    const handle = {};
    scheduled.set(handle, { fn, ms });
    return handle;
  });
  const clearTimer = vi.fn((handle: unknown) => {
    scheduled.delete(handle);
  });
  const fire = (handle: unknown) => scheduled.get(handle)?.fn();
  const lastHandle = () => [...scheduled.keys()].at(-1);
  return { scheduled, setTimer, clearTimer, fire, lastHandle };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('IdleVersioner', () => {
  it('touch() schedules the capture for delayMs later; the callback deletes its own entry', async () => {
    const clock = fakeClock();
    const capture = vi.fn(async () => {});
    const versioner = new IdleVersioner({ delayMs: 50, capture, ...clock });
    versioner.touch('ops');
    expect(clock.setTimer).toHaveBeenCalledWith(expect.any(Function), 50);
    expect(capture).not.toHaveBeenCalled();

    clock.fire(clock.lastHandle());
    await vi.waitFor(() => expect(capture).toHaveBeenCalledWith('ops'));

    // The fired entry is gone: a later touch arms a fresh timer (no stale cancel).
    clock.setTimer.mockClear();
    versioner.touch('ops');
    expect(clock.clearTimer).not.toHaveBeenCalled();
    expect(clock.setTimer).toHaveBeenCalledTimes(1);
  });

  it('three touches in a row leave exactly one pending timer -> one capture', async () => {
    const clock = fakeClock();
    const capture = vi.fn(async () => {});
    const versioner = new IdleVersioner({ delayMs: 50, capture, ...clock });
    versioner.touch('ops');
    versioner.touch('ops');
    versioner.touch('ops');
    expect(clock.scheduled.size).toBe(1);
    expect(clock.clearTimer).toHaveBeenCalledTimes(2);

    clock.fire(clock.lastHandle());
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
  });

  it('cancel() drops the pending timer and does nothing for an unknown id', () => {
    const clock = fakeClock();
    const capture = vi.fn(async () => {});
    const versioner = new IdleVersioner({ delayMs: 50, capture, ...clock });
    versioner.touch('ops');
    versioner.cancel('ops');
    expect(clock.scheduled.size).toBe(0);
    expect(() => versioner.cancel('ops')).not.toThrow();
    versioner.cancel('ghost');
    expect(capture).not.toHaveBeenCalled();
  });

  it('flushAll() runs every pending capture now and clears the timers', async () => {
    const clock = fakeClock();
    const captured: string[] = [];
    const capture = vi.fn(async (agentId: string) => {
      captured.push(agentId);
    });
    const versioner = new IdleVersioner({ delayMs: 50_000, capture, ...clock });
    versioner.touch('a');
    versioner.touch('b');
    await versioner.flushAll();
    expect(captured.sort()).toEqual(['a', 'b']);
    expect(clock.scheduled.size).toBe(0);
    await expect(versioner.flushAll()).resolves.toBeUndefined();
  });

  it('a throwing capture is swallowed - the timer path and flushAll both survive it', async () => {
    const clock = fakeClock();
    const capture = vi.fn(async () => {
      throw new Error('store is gone');
    });
    const versioner = new IdleVersioner({ delayMs: 50, capture, ...clock });
    versioner.touch('ops');
    clock.fire(clock.lastHandle());
    await sleep(1);
    expect(capture).toHaveBeenCalledTimes(1);

    versioner.touch('ops');
    await expect(versioner.flushAll()).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('defaults to IDLE_VERSION_DELAY_MS (60 s)', () => {
    const clock = fakeClock();
    const versioner = new IdleVersioner({ capture: async () => {}, ...clock });
    expect(IDLE_VERSION_DELAY_MS).toBe(60_000);
    versioner.touch('ops');
    expect(clock.setTimer).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  it('the default timer works and does not hold the process open (unref)', async () => {
    const capture = vi.fn(async () => {});
    const versioner = new IdleVersioner({ capture, delayMs: 5 });
    versioner.touch('ops');
    await vi.waitFor(() => expect(capture).toHaveBeenCalledWith('ops'), { timeout: 500 });
  });
});
