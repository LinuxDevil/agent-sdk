import { describe, it, expect, vi } from 'vitest';
import { createAgent } from '../createAgent';
import { SDKError } from '../execution/errors';
import { mockModel } from '../testing';
import { defineSchedule, isDefinedSchedule } from './defineSchedule';
import { startSchedules } from './startSchedules';

const MINUTE = 60_000;

/** A fake clock: timers fire in order as `advance()` moves time forward; nothing sleeps. */
function fakeClock(startIso = '2026-01-01T00:00:00Z') {
  let now = Date.parse(startIso);
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
    pending: () => timers.size,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.fn();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      now = target;
    },
  };
}

const every5 = { cron: '*/5 * * * *', timezone: 'UTC' };

describe('defineSchedule', () => {
  it('accepts a prompt or a run, and marks the result', () => {
    expect(isDefinedSchedule(defineSchedule({ ...every5, prompt: 'hi' }))).toBe(true);
    expect(isDefinedSchedule(defineSchedule({ ...every5, name: 'x', run: async () => undefined }))).toBe(true);
    expect(isDefinedSchedule({ ...every5, prompt: 'hi' })).toBe(false);
  });

  it('rejects an invalid cron expression with a coded error that names the field', () => {
    try {
      defineSchedule({ cron: '61 * * * *', prompt: 'hi' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SDKError);
      expect((error as SDKError).code).toBe('LOUSHY_SCHEDULE_INVALID');
      expect((error as SDKError).message).toContain('61');
    }
    expect(() => defineSchedule({ cron: '* * * *', prompt: 'hi' })).toThrow(/LOUSHY_SCHEDULE_INVALID/);
    expect(() => defineSchedule({ cron: '* * * * *', timezone: 'Mars/Olympus', prompt: 'hi' })).toThrow(/LOUSHY_SCHEDULE_INVALID/);
  });

  it('needs exactly one of prompt and run', () => {
    expect(() => defineSchedule({ cron: '@daily' } as never)).toThrow(/exactly one of 'prompt'/);
    expect(() => defineSchedule({ cron: '@daily', prompt: 'a', run: async () => undefined } as never)).toThrow(/LOUSHY_SCHEDULE_INVALID/);
    expect(() => defineSchedule({ cron: '@daily', prompt: '  ' })).toThrow(/LOUSHY_SCHEDULE_INVALID/);
  });
});

describe('startSchedules', () => {
  it('sends the prompt as a new agent turn at each fire time', async () => {
    const provider = mockModel(['one', 'two']);
    const agent = createAgent({ provider, instructions: 'You report.' });
    const clock = fakeClock();
    const running = startSchedules(agent, [defineSchedule({ ...every5, prompt: 'Status?' })], clock);

    await clock.advance(4 * MINUTE);
    expect(provider.calls).toHaveLength(0);
    await clock.advance(MINUTE);
    expect(provider.calls).toHaveLength(1);
    expect(JSON.stringify(provider.calls[0].messages)).toContain('Status?');
    await clock.advance(5 * MINUTE);
    expect(provider.calls).toHaveLength(2);
    running.stop();
    await agent.close();
  });

  it('calls run with the agent, the fire time and the name', async () => {
    const agent = createAgent({ provider: mockModel(['x']), instructions: 'x' });
    const run = vi.fn(async () => undefined);
    const clock = fakeClock();
    const running = startSchedules(agent, [defineSchedule({ ...every5, name: 'tick', run })], clock);

    await clock.advance(10 * MINUTE);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, { agent, firedAt: new Date('2026-01-01T00:05:00Z'), name: 'tick' });
    expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({ firedAt: new Date('2026-01-01T00:10:00Z') }));
    running.stop();
  });

  it('isolates errors: a failing schedule is reported and the others keep firing', async () => {
    const agent = createAgent({ provider: mockModel(['x']), instructions: 'x' });
    const good = vi.fn(async () => undefined);
    const onError = vi.fn();
    const clock = fakeClock();
    const running = startSchedules(
      agent,
      [
        defineSchedule({ ...every5, name: 'bad', run: () => Promise.reject(new Error('boom')) }),
        defineSchedule({ ...every5, name: 'good', run: good }),
      ],
      { ...clock, onError }
    );

    await clock.advance(10 * MINUTE);
    expect(good).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }), { name: 'bad' });
    running.stop();
  });

  it('does not overlap a schedule with its own still-running previous fire', async () => {
    const agent = createAgent({ provider: mockModel(['x']), instructions: 'x' });
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const onError = vi.fn();
    const clock = fakeClock();
    const running = startSchedules(agent, [defineSchedule({ ...every5, name: 'slow', run })], { ...clock, onError });

    await clock.advance(10 * MINUTE);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('skipped') }), { name: 'slow' });

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await clock.advance(5 * MINUTE);
    expect(run).toHaveBeenCalledTimes(2);
    running.stop();
  });

  it('stop() clears the timers and nothing fires afterwards', async () => {
    const agent = createAgent({ provider: mockModel(['x']), instructions: 'x' });
    const run = vi.fn(async () => undefined);
    const clock = fakeClock();
    const running = startSchedules(agent, [defineSchedule({ ...every5, run })], clock);
    expect(clock.pending()).toBe(1);

    running.stop();
    expect(clock.pending()).toBe(0);
    await clock.advance(30 * MINUTE);
    expect(run).not.toHaveBeenCalled();
  });
});
