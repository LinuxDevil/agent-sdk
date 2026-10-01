import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAgent } from '../createAgent';
import { SDKError } from '../execution/errors';
import { memoryStore } from '../storage/agentStore';
import { mockModel } from '../testing';
import { handleWorkerScheduled } from '../deploy/runtime.worker';
import { defineSchedule } from './defineSchedule';
import { handleScheduled } from './scheduled';
import { specSchedules } from './specSchedules';

function ctx() {
  const promises: Promise<unknown>[] = [];
  return { promises, waitUntil: (promise: Promise<unknown>) => void promises.push(promise) };
}

afterEach(() => vi.restoreAllMocks());

describe('handleScheduled', () => {
  it('runs the schedules matching controller.cron as turns in session schedule:<name>, inside waitUntil', async () => {
    const store = memoryStore();
    const provider = mockModel(['Report sent.']);
    const agent = createAgent({ provider, prompt: 'You report.', store });
    const schedules = [
      defineSchedule({ name: 'report', cron: '0 9 * * MON', prompt: 'Weekly report.' }),
      defineSchedule({ name: 'other', cron: '*/5 * * * *', prompt: 'Not me.' }),
    ];
    const context = ctx();
    const done = handleScheduled(agent, schedules, { cron: '0 9  * * MON' }, context);
    expect(context.promises).toEqual([done]);
    await done;
    expect(provider.calls).toHaveLength(1);
    const session = await store.checkpoints?.load('schedule:report');
    expect(JSON.stringify(session)).toContain('Weekly report.');
  });

  it('runs every schedule sharing the expression and isolates a failing one', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ran: string[] = [];
    const agent = createAgent({ provider: mockModel(['ok']), prompt: 'x' });
    const schedules = [
      defineSchedule({ name: 'bad', cron: '0 * * * *', run: async () => Promise.reject(new SDKError('boom', 'LOUSHY_TEST')) }),
      defineSchedule({ name: 'good', cron: '0 * * * *', run: async ({ name }) => void ran.push(name) }),
    ];
    await expect(handleScheduled(agent, schedules, { cron: '0 * * * *' }, ctx())).resolves.toBeUndefined();
    expect(ran).toEqual(['good']);
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0][0])).toContain("'bad'");
    expect(String(error.mock.calls[0][0])).toContain('LOUSHY_TEST');
  });
});

describe('specSchedules', () => {
  it('builds schedules from cron triggers only, accepting input or prompt', () => {
    const schedules = specSchedules([
      { type: 'webhook' },
      { type: 'cron', cron: '0 9 * * MON', input: 'Report.' },
      { type: 'cron', name: 'nightly', cron: '0 2 * * *', prompt: 'Clean up.' },
    ]);
    expect(schedules.map((s) => [s.name, s.cron, s.prompt])).toEqual([
      ['cron-1', '0 9 * * MON', 'Report.'],
      ['nightly', '0 2 * * *', 'Clean up.'],
    ]);
  });

  it('names the trigger in the error for a missing or invalid field', () => {
    expect(() => specSchedules([{ type: 'cron', name: 'x', input: 'hi' }])).toThrow(/trigger 'x'.*'cron'/);
    expect(() => specSchedules([{ type: 'cron', name: 'y', cron: '* * * * *' }])).toThrow(/trigger 'y'.*'input'/);
    expect(() => specSchedules([{ type: 'cron', name: 'z', cron: '61 * * * *', input: 'hi' }])).toThrow(/trigger 'z'/);
  });
});

describe('handleWorkerScheduled', () => {
  const spec = {
    name: 'w',
    prompt: 'p',
    provider: { type: 'mock', model: 'mock-1' },
    triggers: [{ type: 'cron', name: 'tick', cron: '*/5 * * * *', input: 'tick' }],
  };

  it('does nothing for a cron no trigger declares', async () => {
    const context = ctx();
    await handleWorkerScheduled({ cron: '1 1 * * *' }, {}, context, spec);
    expect(context.promises).toHaveLength(1);
  });

  it('logs instead of throwing when the agent cannot be built', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      handleWorkerScheduled({ cron: '*/5 * * * *' }, {}, ctx(), { ...spec, tools: ['http'] })
    ).resolves.toBeUndefined();
    expect(String(error.mock.calls[0][0])).toContain('*/5 * * * *');
  });
});
