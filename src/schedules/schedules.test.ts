import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { SDKError } from '../execution/errors';
import { memoryStore } from '../storage/agentStore';
import { mockModel } from '../testing';
import { defineTool } from '../tools/defineTool';
import { defineSchedule, isDefinedSchedule } from './defineSchedule';
import { fireSchedule as fireScheduleFromIndex, type FireScheduleOptions } from '../index';
import { fireSchedule } from './fireSchedule';
import { startSchedules } from './startSchedules';

afterEach(() => { vi.restoreAllMocks(); });

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
      expect((error as SDKError).code).toBe('LOUSHO_SCHEDULE_INVALID');
      expect((error as SDKError).message).toContain('61');
    }
    expect(() => defineSchedule({ cron: '* * * *', prompt: 'hi' })).toThrow(/LOUSHO_SCHEDULE_INVALID/);
    expect(() => defineSchedule({ cron: '* * * * *', timezone: 'Mars/Olympus', prompt: 'hi' })).toThrow(/LOUSHO_SCHEDULE_INVALID/);
  });

  it('needs exactly one of prompt and run', () => {
    expect(() => defineSchedule({ cron: '@daily' } as never)).toThrow(/exactly one of 'prompt'/);
    expect(() => defineSchedule({ cron: '@daily', prompt: 'a', run: async () => undefined } as never)).toThrow(/LOUSHO_SCHEDULE_INVALID/);
    expect(() => defineSchedule({ cron: '@daily', prompt: '  ' })).toThrow(/LOUSHO_SCHEDULE_INVALID/);
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

  it('runs each fire in its own durable session, schedule-<name>-<fire time> (Eve DUR-F10)', async () => {
    const store = memoryStore();
    const provider = mockModel(['ok'], { onExhausted: 'repeat-last' });
    const agent = createAgent({ provider, instructions: 'x', store });
    const clock = fakeClock();
    const running = startSchedules(agent, [defineSchedule({ ...every5, name: 'status', prompt: 'Status?' })], clock);
    await clock.advance(5 * MINUTE);
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
    await clock.advance(5 * MINUTE);
    await running.stop();
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].messages).toHaveLength(provider.calls[0].messages.length);
    expect(JSON.stringify(await store.checkpoints?.load('schedule-status-2026-01-01T000500Z'))).toContain('Status?');
    expect(JSON.stringify(await store.checkpoints?.load('schedule-status-2026-01-01T001000Z'))).toContain('Status?');
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

  it('reports a prompt turn that pauses for approval as LOUSHO_SCHEDULE_RUN_INCOMPLETE, naming the approval', async () => {
    const tool = defineTool({ name: 'send_email', description: 'Sends', input: z.object({ to: z.string() }), needsApproval: true, execute: async () => 'sent' });
    const call = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_1' }] };
    const agent = createAgent({ provider: mockModel([call]), tools: [tool] });
    const onError = vi.fn();
    const clock = fakeClock();
    const running = startSchedules(agent, [defineSchedule({ ...every5, name: 'mail', prompt: 'Email Sam.' })], { ...clock, onError });

    await clock.advance(5 * MINUTE);
    await running.stop();
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, schedule] = onError.mock.calls[0] as [SDKError, { name: string }];
    expect(schedule).toEqual({ name: 'mail' });
    expect(error).toBeInstanceOf(SDKError);
    expect(error.code).toBe('LOUSHO_SCHEDULE_RUN_INCOMPLETE');
    const [pending] = await agent.approvals.list();
    expect(error.detail).toContain('awaiting-approval');
    expect(error.detail).toContain(pending.id);
  });

  it("reports a prompt turn that ends 'output-invalid'", async () => {
    const agent = createAgent({ provider: mockModel(['not json', 'still not']), output: z.object({ ok: z.boolean() }) });
    const onError = vi.fn();
    const clock = fakeClock();
    const running = startSchedules(agent, [defineSchedule({ ...every5, name: 'json', prompt: 'Reply.' })], { ...clock, onError });

    await clock.advance(5 * MINUTE);
    await running.stop();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'LOUSHO_SCHEDULE_RUN_INCOMPLETE', detail: expect.stringContaining('output-invalid') }), { name: 'json' });
  });

  it('stop() resolves only once the run in flight has finished', async () => {
    const agent = createAgent({ provider: mockModel(['x']), instructions: 'x' });
    let release: () => void = () => undefined;
    let finished = false;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)).then(() => void (finished = true)));
    const clock = fakeClock();
    const running = startSchedules(agent, [defineSchedule({ ...every5, run })], clock);
    await clock.advance(5 * MINUTE);
    expect(run).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = running.stop().then(() => void (stopped = true));
    expect(clock.pending()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
  });

  it("unrefs the default timers unless keepAlive is set", async () => {
    const agent = createAgent({ provider: mockModel(['x']), instructions: 'x' });
    const timers: NodeJS.Timeout[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
      const timer = real(fn, ms);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout);
    const schedule = defineSchedule({ ...every5, run: async () => undefined });

    const detached = startSchedules(agent, [schedule]);
    const kept = startSchedules(agent, [schedule], { keepAlive: true });
    expect(timers.map((timer) => timer.hasRef())).toEqual([false, true]);
    await detached.stop();
    await kept.stop();
  });
});

describe('fireSchedule', () => {
  it('is exported and fires a schedule once, now, in the given session', async () => {
    expect(fireScheduleFromIndex).toBe(fireSchedule);
    const provider = mockModel(['done']);
    const store = memoryStore();
    const agent = createAgent({ provider, instructions: 'x', store });
    const options: FireScheduleOptions = { sessionId: 'ops-run' };
    await fireSchedule(agent, defineSchedule({ ...every5, prompt: 'Run now.' }), options);
    expect(provider.calls).toHaveLength(1);
    expect(JSON.stringify(provider.calls[0].messages)).toContain('Run now.');
    expect(JSON.stringify(await store.checkpoints?.load('ops-run'))).toContain('Run now.');

    const run = vi.fn(async () => undefined);
    const firedAt = new Date('2026-02-01T00:00:00Z');
    await fireSchedule(agent, defineSchedule({ ...every5, name: 'tick', run }), { firedAt });
    expect(run).toHaveBeenCalledWith({ agent, firedAt, name: 'tick' });
  });

  it('rejects with LOUSHO_SCHEDULE_RUN_INCOMPLETE when the turn does not stop', async () => {
    const agent = createAgent({ provider: mockModel(['a', 'b']), output: z.object({ ok: z.boolean() }) });
    await expect(fireSchedule(agent, defineSchedule({ ...every5, name: 'n', prompt: 'p' }))).rejects.toMatchObject({ code: 'LOUSHO_SCHEDULE_RUN_INCOMPLETE' });
  });
});
