import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TriggerSpec } from 'lousho/spec';

import type { DispatchRequest, DispatchResult, TriggerHost } from '../triggers/triggerHost';
import { CronTriggers, type CronState } from '../triggers/cronTriggers';

const CRON: TriggerSpec = {
  id: 't1',
  type: 'cron',
  cron: '*/5 * * * *',
  timezone: 'UTC',
  prompt: 'tick prompt',
};

const CRON2: TriggerSpec = { ...CRON, id: 't2', cron: '0 * * * *' };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cron-triggers-'));
}

/** `<baseDir>/.lousho/agents/<id>.yaml` - listIds only needs the file to exist. */
function addAgent(baseDir: string, id: string): void {
  const dir = path.join(baseDir, '.lousho', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.yaml`), 'version: 2\n');
}

function stateFile(baseDir: string, agentId: string): string {
  return path.join(baseDir, '.lousho', 'agents', agentId, 'triggers', 'state.json');
}

function readState(baseDir: string, agentId: string): CronState {
  return JSON.parse(fs.readFileSync(stateFile(baseDir, agentId), 'utf8')) as CronState;
}

function fakeHost(specs: Record<string, TriggerSpec[]>) {
  const triggersOf = vi.fn<[agentId: string], TriggerSpec[]>((agentId) => specs[agentId] ?? []);
  const dispatch = vi.fn<[req: DispatchRequest], DispatchResult>(() => ({ ok: true, runKey: 'rk', started: true }));
  const log = vi.fn();
  return { host: { triggersOf, dispatch, log } as unknown as TriggerHost, triggersOf, dispatch, log };
}

describe('CronTriggers', () => {
  let baseDir: string;
  let now: Date;
  const made: CronTriggers[] = [];

  beforeEach(() => {
    baseDir = tmpDir();
    now = new Date('2026-01-01T10:00:00.000Z');
  });

  afterEach(() => {
    for (const cron of made.splice(0)) cron.stop();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function make(specs: Record<string, TriggerSpec[]>, dispatchResult?: DispatchResult) {
    addAgent(baseDir, 'a');
    const fake = fakeHost(specs);
    if (dispatchResult !== undefined) fake.dispatch.mockReturnValue(dispatchResult);
    const cron = new CronTriggers({ baseDir, host: fake.host, now: () => now });
    made.push(cron);
    return { cron, ...fake };
  }

  it('does not fire on the first tick; fires once the next boundary passes', async () => {
    const { cron, dispatch } = make({ a: [CRON] });

    await cron.tick(); // 10:00 - new trigger: cursor set, no fire
    expect(dispatch).not.toHaveBeenCalled();
    expect(readState(baseDir, 'a').t1).toEqual({
      lastRunAt: '2026-01-01T10:00:00.000Z',
      expression: '*/5 * * * *',
      timezone: 'UTC',
    });

    now = new Date('2026-01-01T10:04:00.000Z');
    await cron.tick();
    expect(dispatch).not.toHaveBeenCalled();

    now = new Date('2026-01-01T10:05:00.500Z');
    await cron.tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      agentId: 'a',
      triggerId: 't1',
      input: 'tick prompt',
      event: { type: 'cron', scheduledAt: '2026-01-01T10:05:00.000Z', firedAt: '2026-01-01T10:05:00.500Z' },
    });
    expect(readState(baseDir, 'a').t1.lastRunAt).toBe('2026-01-01T10:05:00.500Z');
  });

  it('fires exactly once after downtime, never catching up', async () => {
    const { cron, dispatch } = make({ a: [CRON] });
    await cron.tick(); // cursor at 10:00

    now = new Date('2026-01-01T11:00:00.000Z'); // an hour later
    await cron.tick();
    await cron.tick();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0][0].event as { scheduledAt: string }).scheduledAt).toBe('2026-01-01T10:05:00.000Z');
  });

  it('editing the cron expression resets the cursor without firing', async () => {
    const specs: Record<string, TriggerSpec[]> = { a: [CRON] };
    const { cron, dispatch, triggersOf } = make(specs);
    await cron.tick(); // 10:00 cursor

    specs.a = [{ ...CRON, cron: '*/10 * * * *' }];
    triggersOf.mockImplementation((id: string) => specs[id] ?? []);
    now = new Date('2026-01-01T10:07:00.000Z');
    await cron.tick(); // schedule changed: cursor -> 10:07, no fire

    expect(dispatch).not.toHaveBeenCalled();
    expect(readState(baseDir, 'a').t1).toMatchObject({ expression: '*/10 * * * *', lastRunAt: '2026-01-01T10:07:00.000Z' });

    now = new Date('2026-01-01T10:11:00.000Z');
    await cron.tick(); // next 10-min boundary after 10:07 is 10:10 - due, fires once
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0][0].event as { scheduledAt: string }).scheduledAt).toBe('2026-01-01T10:10:00.000Z');
  });

  it('two concurrent tick() calls dispatch once', async () => {
    const { cron, dispatch } = make({ a: [CRON] });
    await cron.tick();
    now = new Date('2026-01-01T10:05:00.000Z');

    await Promise.all([cron.tick(), cron.tick()]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('logs an invalid schedule once and keeps other triggers firing', async () => {
    const bad: TriggerSpec = { ...CRON, id: 'bad', cron: 'not a schedule' };
    const { cron, log } = make({ a: [bad, CRON] });

    await cron.tick();
    await cron.tick();

    const badLogs = log.mock.calls.filter((c) => String(c[1]).includes('invalid schedule'));
    expect(badLogs).toHaveLength(1);
    expect(String(badLogs[0][1])).toContain('Cron trigger bad has an invalid schedule:');
    // The valid trigger still got its cursor.
    expect(readState(baseDir, 'a').t1).toBeDefined();
  });

  it('logs queue_full as skipped and still advances the cursor', async () => {
    const { cron, dispatch, log } = make({ a: [CRON] }, { ok: false, reason: 'queue_full' });
    await cron.tick();
    now = new Date('2026-01-01T10:05:00.000Z');
    await cron.tick();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('a', 'Cron trigger t1 skipped: the queue is full', 'warn');
    expect(readState(baseDir, 'a').t1.lastRunAt).toBe('2026-01-01T10:05:00.000Z');

    now = new Date('2026-01-01T10:10:00.000Z');
    await cron.tick();
    expect(dispatch).toHaveBeenCalledTimes(2); // the lost window is never retried; the next one fires
  });

  it('logs a fired line on successful dispatch', async () => {
    const { cron, log } = make({ a: [CRON] });
    await cron.tick();
    now = new Date('2026-01-01T10:05:00.000Z');
    await cron.tick();
    expect(log).toHaveBeenCalledWith('a', 'Cron trigger t1 fired');
  });

  it('deletes state entries for triggers removed from the spec', async () => {
    const specs: Record<string, TriggerSpec[]> = { a: [CRON, CRON2] };
    const { cron, triggersOf } = make(specs);
    await cron.tick();
    expect(Object.keys(readState(baseDir, 'a')).sort()).toEqual(['t1', 't2']);

    specs.a = [CRON];
    triggersOf.mockImplementation((id: string) => specs[id] ?? []);
    await cron.tick();
    expect(Object.keys(readState(baseDir, 'a'))).toEqual(['t1']);
  });
});
