import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type { AgentRunStatusPayload, StudioEvent } from '../../../shared/wireTypes';
import { AgentRepo } from '../../storage/agentRepo';
import { StudioEventBus } from '../../events/eventBus';
import { AlertStore } from '../../inbox/alertStore';
import type { RunManager } from '../../runRegistry';
import { attachFailureStreak, FAILURE_STREAK_LIMIT } from '../failureStreak';

const AGENT = 'streaky';
const SPEC = { version: 2, name: 'Streaky', model: 'mock/mock-1', instructions: 'x' } as unknown as AgentSpecV2;

/** Polls `read` until `predicate` holds or the deadline passes - the streak writes are fire-and-forget off the status event. Polls on a timer, not setImmediate: back-to-back reads race writeFileAtomic's rename on Windows (EPERM). */
async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('attachFailureStreak', () => {
  let dir: string;
  let repo: AgentRepo;
  let alerts: AlertStore;
  let events: StudioEventBus;
  let runs: EventEmitter;
  let published: StudioEvent[];
  let detach: () => void;

  const status = (patch: Partial<AgentRunStatusPayload>): AgentRunStatusPayload => ({
    agentId: AGENT,
    status: 'idle',
    updatedAt: new Date().toISOString(),
    ...patch,
  });

  /** One full triggered run lifecycle: launch then settle. */
  const triggeredRun = (outcome: 'done' | 'error', error?: string) => {
    runs.emit('status', status({ status: 'running', source: 'trigger', triggerId: 't1' }));
    runs.emit('status', status({ status: outcome, source: 'trigger', triggerId: 't1', error }));
  };
  const manualRun = (outcome: 'done' | 'error') => {
    runs.emit('status', status({ status: 'running' }));
    runs.emit('status', status({ status: outcome }));
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-l12-streak-'));
    repo = new AgentRepo(dir);
    alerts = new AlertStore(path.join(dir, 'alerts.json'));
    events = new StudioEventBus();
    runs = new EventEmitter();
    published = [];
    events.subscribe((event) => published.push(event));
    await repo.writeSpec(AGENT, SPEC);
    detach = attachFailureStreak({
      runManager: runs as unknown as RunManager,
      repo,
      alerts,
      events,
      workspaceId: 'ws-test',
    });
  });

  afterEach(() => {
    detach();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const meta = () => repo.readMeta(AGENT);

  it('counts consecutive triggered errors and auto-disables at the limit with one alert', async () => {
    for (let i = 0; i < FAILURE_STREAK_LIMIT - 1; i++) {
      triggeredRun('error', `boom ${i}`);
      await waitFor(meta, (m) => m.failureStreak === i + 1, `streak ${i + 1}`);
    }
    let m = await meta();
    expect(m.enabled).toBe(true);
    expect(m.disabledReason).toBeNull();

    triggeredRun('error', 'final boom');
    // The alert lands after the meta write inside the same lock, so wait
    // on the alert itself rather than the disabled flag.
    await waitFor(async () => alerts.list(), (list) => list.length === 1, 'auto_disabled alert');
    m = await meta();
    expect(m.enabled).toBe(false);
    expect(m.failureStreak).toBe(FAILURE_STREAK_LIMIT);
    expect(m.disabledReason).toBe('auto_failure_streak');
    expect(m.disabledAt).not.toBeNull();

    const list = await alerts.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: 'auto_disabled',
      agentId: AGENT,
      workspaceId: 'ws-test',
      title: 'Streaky was turned off after 5 failed runs',
      detail: 'final boom',
      payload: { failureStreak: FAILURE_STREAK_LIMIT, lastTraceId: null },
    });
    expect(published).toContainEqual({ type: 'agent.changed', agentId: AGENT, reason: 'meta' });
  });

  it('a triggered success resets the streak; manual runs neither count nor reset', async () => {
    for (let i = 0; i < 3; i++) {
      triggeredRun('error', 'x');
      await waitFor(meta, (m) => m.failureStreak === i + 1, `streak ${i + 1}`);
    }
    triggeredRun('done');
    await waitFor(meta, (m) => m.failureStreak === 0, 'streak reset');

    // Manual failures never move the counter.
    manualRun('error');
    manualRun('error');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await meta()).failureStreak).toBe(0);

    // And a manual success does not reset a real streak either.
    triggeredRun('error', 'x');
    await waitFor(meta, (m) => m.failureStreak === 1, 'streak 1');
    manualRun('done');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await meta()).failureStreak).toBe(1);
  });

  it('a sixth failure while already off adds no second alert', async () => {
    for (let i = 0; i < FAILURE_STREAK_LIMIT; i++) {
      triggeredRun('error', `boom ${i}`);
      await waitFor(meta, (m) => m.failureStreak === i + 1, `streak ${i + 1}`);
    }
    triggeredRun('error', 'one more');
    await waitFor(meta, (m) => m.failureStreak === FAILURE_STREAK_LIMIT + 1, 'streak 6');
    expect(await alerts.list()).toHaveLength(1);
    expect((await meta()).disabledReason).toBe('auto_failure_streak');
  });

  it('ignores stopped/paused/idle and error/done without a running transition', async () => {
    runs.emit('status', status({ status: 'running', source: 'trigger', triggerId: 't1' }));
    runs.emit('status', status({ status: 'stopped', source: 'trigger', triggerId: 't1' }));
    runs.emit('status', status({ status: 'paused', source: 'trigger', triggerId: 't1' }));
    // An error with no preceding 'running' (e.g. a status replay) does not count.
    runs.emit('status', status({ status: 'error', source: 'trigger', triggerId: 't1' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await meta()).failureStreak).toBe(0);
    expect(await alerts.list()).toEqual([]);
  });

  it('keeps counting a run resumed through approve() (paused -> running -> error still transitions)', async () => {
    runs.emit('status', status({ status: 'running', source: 'trigger', triggerId: 't1' }));
    runs.emit('status', status({ status: 'paused', reason: 'awaiting_approval', source: 'trigger', triggerId: 't1' }));
    runs.emit('status', status({ status: 'running', source: 'trigger', triggerId: 't1' }));
    runs.emit('status', status({ status: 'error', source: 'trigger', triggerId: 't1', error: 'after approve' }));
    await waitFor(meta, (m) => m.failureStreak === 1, 'streak 1');
  });

  it('unsubscribe stops counting', async () => {
    detach();
    triggeredRun('error', 'x');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await meta()).failureStreak).toBe(0);
  });
});
