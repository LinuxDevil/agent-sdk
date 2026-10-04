import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronTriggerAdapter } from './CronTriggerAdapter';
import { ExecutionResult } from '../../execution/AgentExecutor';
import { emptyRunUsage } from '../../execution/runUsage';
import { RunnableAgent } from '../types';

function fakeResult(text: string): ExecutionResult {
  return {
    text,
    messages: [],
    toolCalls: [],
    usage: emptyRunUsage(),
    finishReason: 'stop',
    steps: 1,
  };
}

const noopAgent: RunnableAgent = { send: vi.fn() };

describe('CronTriggerAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('has type "cron"', () => {
    expect(new CronTriggerAdapter({ intervalMs: 1000, input: 'x', onResult: vi.fn() }).type).toBe('cron');
  });

  it('throws if intervalMs is not a positive number', () => {
    expect(() => new CronTriggerAdapter({ intervalMs: 0, input: 'x', onResult: vi.fn() })).toThrow();
    expect(() => new CronTriggerAdapter({ intervalMs: -5, input: 'x', onResult: vi.fn() })).toThrow();
  });

  it('does not fire immediately by default', () => {
    const onEvent = vi.fn().mockResolvedValue(fakeResult('tick'));
    const adapter = new CronTriggerAdapter({ intervalMs: 1000, input: 'scheduled', onResult: vi.fn() });
    adapter.listen(noopAgent, onEvent);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('fires immediately when fireImmediately is true', () => {
    const onEvent = vi.fn().mockResolvedValue(fakeResult('tick'));
    const adapter = new CronTriggerAdapter({
      intervalMs: 1000,
      input: 'scheduled',
      onResult: vi.fn(),
      fireImmediately: true,
    });
    adapter.listen(noopAgent, onEvent);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith('scheduled', expect.objectContaining({ tick: 0 }));
  });

  it('fires onEvent on every interval tick and reports each result to onResult', async () => {
    const onEvent = vi.fn().mockResolvedValue(fakeResult('tick'));
    const onResult = vi.fn();
    const adapter = new CronTriggerAdapter({ intervalMs: 1000, input: 'scheduled', onResult });
    adapter.listen(noopAgent, onEvent);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenNthCalledWith(1, fakeResult('tick'), undefined, expect.objectContaining({ tick: 0 }));
    expect(onResult).toHaveBeenNthCalledWith(2, fakeResult('tick'), undefined, expect.objectContaining({ tick: 1 }));
  });

  it('reports a failed run to onResult with the error and no result', async () => {
    const onEvent = vi.fn().mockRejectedValue(new Error('run failed'));
    const onResult = vi.fn();
    const adapter = new CronTriggerAdapter({ intervalMs: 1000, input: 'scheduled', onResult });
    adapter.listen(noopAgent, onEvent);

    await vi.advanceTimersByTimeAsync(1000);

    expect(onResult).toHaveBeenCalledWith(undefined, expect.any(Error), expect.anything());
  });

  it('stop() clears the interval so no further ticks fire', async () => {
    const onEvent = vi.fn().mockResolvedValue(fakeResult('tick'));
    const adapter = new CronTriggerAdapter({ intervalMs: 1000, input: 'scheduled', onResult: vi.fn() });
    const handle = adapter.listen(noopAgent, onEvent);

    handle.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('has no reply() method (no reply target for a scheduled run)', () => {
    const adapter = new CronTriggerAdapter({ intervalMs: 1000, input: 'x', onResult: vi.fn() });
    expect('reply' in adapter).toBe(false);
  });
});

describe('CronTriggerAdapter with a cron expression', () => {
  const start = (options: { cron: string; timezone?: string; fireImmediately?: boolean }) => {
    const onEvent = vi.fn().mockResolvedValue(fakeResult('tick'));
    const onResult = vi.fn();
    const adapter = new CronTriggerAdapter({ input: 'scheduled', onResult, ...options });
    return { onEvent, onResult, handle: adapter.listen(noopAgent, onEvent) };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires at each matching minute, without drift or double-firing, with a single timer', async () => {
    const { onEvent, onResult, handle } = start({ cron: '* * * * *' });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(onEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      'scheduled',
      expect.objectContaining({ firedAt: '2026-01-01T00:01:00.000Z', tick: 0 })
    );
    expect(onResult).toHaveBeenCalledWith(fakeResult('tick'), undefined, expect.anything());
    expect(vi.getTimerCount()).toBe(1); // re-armed

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(onEvent).toHaveBeenCalledTimes(11);
    expect(new Date().toISOString()).toBe('2026-01-01T00:11:00.000Z');
    handle.stop();
  });

  it('honours the time zone', async () => {
    const { onEvent, handle } = start({ cron: '0 9 * * *', timezone: 'Asia/Kolkata' });
    await vi.advanceTimersByTimeAsync(3 * 3600_000 + 29 * 60_000); // 03:29:30Z
    expect(onEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onEvent).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("chains timers for delays beyond setTimeout's maximum (~24.8 days) and fires once", async () => {
    const { onEvent, handle } = start({ cron: '0 0 1 1 *', timezone: 'UTC' }); // next: 2027-01-01, ~365 days away
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(364 * 86_400_000);
    expect(onEvent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 86_400_000);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      'scheduled',
      expect.objectContaining({ firedAt: '2027-01-01T00:00:00.000Z' })
    );
    handle.stop();
  });

  it('fireImmediately fires once right away in addition to the schedule', async () => {
    const { onEvent, handle } = start({ cron: '* * * * *', fireImmediately: true });
    expect(onEvent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onEvent).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('keeps the schedule alive when a run fails', async () => {
    const onEvent = vi.fn().mockRejectedValue(new Error('boom'));
    const onResult = vi.fn();
    const handle = new CronTriggerAdapter({ cron: '* * * * *', input: 'x', onResult }).listen(noopAgent, onEvent);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith(undefined, expect.any(Error), expect.anything());
    handle.stop();
  });

  it('stop() clears the timer and nothing fires afterwards', async () => {
    const { onEvent, handle } = start({ cron: '* * * * *' });
    handle.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('skips missed runs after a long suspension instead of firing a burst', async () => {
    const { onEvent, handle } = start({ cron: '* * * * *' });
    vi.setSystemTime(new Date('2026-01-01T05:00:10Z')); // clock jumped (e.g. laptop sleep)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onEvent).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('validates its options', () => {
    const base = { input: 'x', onResult: vi.fn() };
    expect(() => new CronTriggerAdapter({ ...base, cron: 'nope' })).toThrow(/expected 5 space-separated fields/);
    expect(() => new CronTriggerAdapter({ ...base, cron: '* * * * *', timezone: 'Nowhere/Land' })).toThrow(
      /timezone/
    );
    expect(() => new CronTriggerAdapter({ ...base } as never)).toThrow(/exactly one of/);
    expect(() => new CronTriggerAdapter({ ...base, intervalMs: 1000, cron: '* * * * *' } as never)).toThrow(
      /exactly one of/
    );
  });
});
