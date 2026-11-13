import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type { TriggerSpec } from '@linuxdevil/lousho/spec';

import type { AgentRepo } from '../storage/agentRepo';
import { AlreadyRunningError, type RunManager } from '../runRegistry';
import { StudioEventBus } from '../events/eventBus';
import { TriggerHost, type RunEnd } from '../triggers/triggerHost';

const WEBHOOK: TriggerSpec = {
  id: 't1',
  type: 'webhook',
  path: '/hooks/t1',
  promptTemplate: 'hi {{event.x}}',
};

const CRON: TriggerSpec = { id: 'c1', type: 'cron', cron: '* * * * *', prompt: 'tick' };

function specWith(triggers: TriggerSpec[]): AgentSpecV2 {
  return { version: 2, name: 'a', triggers } as unknown as AgentSpecV2;
}

/** A RunManager stand-in: records run() calls, emits 'status' on demand. */
class FakeRuns extends EventEmitter {
  calls: { agentId: string; input: string; options?: { source?: string; triggerId?: string } }[] = [];
  failWith: 'already' | Error | undefined;

  async run(
    agentId: string,
    input: string,
    _spec?: unknown,
    options?: { source?: string; triggerId?: string; triggerEvent?: unknown }
  ): Promise<void> {
    if (this.failWith === 'already') throw new AlreadyRunningError(`Agent '${agentId}' is already running`);
    if (this.failWith instanceof Error) throw this.failWith;
    this.calls.push({ agentId, input, options });
  }

  async abort(): Promise<void> {}

  emitStatus(agentId: string, status: string, extra: Record<string, unknown> = {}): void {
    this.emit('status', { agentId, status, ...extra });
  }
}

function repoWith(specs: Record<string, AgentSpecV2 | undefined>): AgentRepo {
  return {
    listIds: () => Object.keys(specs),
    readSpec: async (id: string) => specs[id],
  } as unknown as AgentRepo;
}

const made: TriggerHost[] = [];

function makeHost(specs: Record<string, AgentSpecV2 | undefined>, queueCap?: number) {
  const runs = new FakeRuns();
  const events = new StudioEventBus();
  const logs: string[] = [];
  const host = new TriggerHost({
    repo: repoWith(specs),
    runManager: runs as unknown as RunManager,
    events,
    log: (_agentId, message) => logs.push(message),
    ...(queueCap !== undefined ? { queueCap } : {}),
  });
  made.push(host);
  return { host, runs, events, logs };
}

afterEach(() => {
  for (const host of made.splice(0)) host.stop();
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('TriggerHost', () => {
  it('starts the first dispatch immediately and queues the rest FIFO', async () => {
    const { host, runs } = makeHost({ a: specWith([WEBHOOK, CRON]) });
    await host.start();

    const d1 = host.dispatch({ agentId: 'a', triggerId: 't1', input: 'one', event: { n: 1 } });
    const d2 = host.dispatch({ agentId: 'a', triggerId: 'c1', input: 'two', event: {} });
    const d3 = host.dispatch({ agentId: 'a', triggerId: 't1', input: 'three', event: {} });
    await flush();

    expect(d1).toMatchObject({ ok: true, started: true });
    expect(d2).toMatchObject({ ok: true, started: false });
    expect(d3).toMatchObject({ ok: true, started: false });
    expect(runs.calls).toHaveLength(1);
    expect(runs.calls[0]).toMatchObject({ agentId: 'a', input: 'one', options: { source: 'trigger', triggerId: 't1' } });

    const runsList = host.runsOf('a');
    expect(runsList.map((r) => r.status)).toEqual(['running', 'queued', 'queued']);
    expect(runsList.slice(1).map((r) => r.input)).toEqual(['two', 'three']);
  });

  it('fires exactly one RunEnd on a terminal status, then starts the next queued run', async () => {
    const { host, runs } = makeHost({ a: specWith([WEBHOOK, CRON]) });
    await host.start();
    const ends: RunEnd[] = [];
    host.onRunEnd((end) => ends.push(end));

    host.dispatch({ agentId: 'a', triggerId: 't1', input: 'one', event: {} });
    host.dispatch({ agentId: 'a', triggerId: 'c1', input: 'two', event: {} });
    await flush();

    runs.emitStatus('a', 'done', { resultText: 'fin', traceId: 'tr-1' });
    await flush();

    expect(ends).toHaveLength(1);
    expect(ends[0].status).toBe('done');
    expect(ends[0].run.input).toBe('one');
    expect(ends[0].resultText).toBe('fin');
    expect(ends[0].traceId).toBe('tr-1');
    expect(ends[0].cancelled).toBe(false);
    expect(runs.calls).toHaveLength(2);
    expect(runs.calls[1].input).toBe('two');
    expect(host.runsOf('a').map((r) => r.status)).toEqual(['running']);
  });

  it('does not end a run paused awaiting approval', async () => {
    const { host, runs } = makeHost({ a: specWith([WEBHOOK]) });
    await host.start();
    const ends: unknown[] = [];
    host.onRunEnd((end) => ends.push(end));

    host.dispatch({ agentId: 'a', triggerId: 't1', input: 'one', event: {} });
    await flush();
    runs.emitStatus('a', 'paused', { reason: 'awaiting_approval' });
    await flush();

    expect(ends).toHaveLength(0);
    expect(host.runsOf('a')[0].status).toBe('running');
    expect(runs.calls).toHaveLength(1);
  });

  it('marks a stopped run cancelled', async () => {
    const { host, runs } = makeHost({ a: specWith([WEBHOOK]) });
    await host.start();
    const ends: { cancelled: boolean; status: string }[] = [];
    host.onRunEnd((end) => ends.push(end));

    host.dispatch({ agentId: 'a', triggerId: 't1', input: 'one', event: {} });
    await flush();
    runs.emitStatus('a', 'stopped');

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ status: 'stopped', cancelled: true });
  });

  it('keeps a request queued on AlreadyRunningError and retries on the next terminal status', async () => {
    const { host, runs } = makeHost({ a: specWith([WEBHOOK]) });
    await host.start();

    runs.failWith = 'already';
    const d = host.dispatch({ agentId: 'a', triggerId: 't1', input: 'one', event: {} });
    await flush();
    expect(d).toMatchObject({ ok: true, started: true });
    expect(host.runsOf('a').map((r) => r.status)).toEqual(['queued']);
    expect(runs.calls).toHaveLength(0);

    // The manual run that won the race ends; the queued request retries.
    runs.failWith = undefined;
    runs.emitStatus('a', 'done');
    await flush();

    expect(runs.calls).toHaveLength(1);
    expect(runs.calls[0].input).toBe('one');
    expect(host.runsOf('a').map((r) => r.status)).toEqual(['running']);
  });

  it('returns queue_full past the cap and unknown_trigger for a missing id', async () => {
    const { host } = makeHost({ a: specWith([WEBHOOK]) }, 2);
    await host.start();

    // The first dispatch takes the agent; the cap counts queued requests.
    host.dispatch({ agentId: 'a', triggerId: 't1', input: 'one', event: {} });
    host.dispatch({ agentId: 'a', triggerId: 't1', input: 'two', event: {} });
    host.dispatch({ agentId: 'a', triggerId: 't1', input: 'three', event: {} });
    expect(host.dispatch({ agentId: 'a', triggerId: 't1', input: 'four', event: {} })).toEqual({
      ok: false,
      reason: 'queue_full',
    });
    expect(host.dispatch({ agentId: 'a', triggerId: 'nope', input: 'x', event: {} })).toEqual({
      ok: false,
      reason: 'unknown_trigger',
    });
  });

  it('drops queued runs whose trigger was removed on reload', async () => {
    const specs: Record<string, AgentSpecV2 | undefined> = { a: specWith([WEBHOOK, CRON]) };
    const { host, runs, logs } = makeHost(specs);
    await host.start();

    // Occupy the agent so the second dispatch stays queued.
    host.dispatch({ agentId: 'a', triggerId: 't1', input: 'one', event: {} });
    host.dispatch({ agentId: 'a', triggerId: 'c1', input: 'two', event: {} });
    await flush();
    expect(host.runsOf('a')).toHaveLength(2);

    specs.a = specWith([WEBHOOK]); // c1 removed
    await host.reload('a');

    expect(host.runsOf('a')).toHaveLength(1);
    expect(host.runsOf('a')[0].triggerId).toBe('t1');
    expect(logs.some((m) => m.includes('c1') && m.includes('was removed'))).toBe(true);
    expect(runs.calls).toHaveLength(1);
  });

  it('reloads triggers on agent.changed and serves triggersOf', async () => {
    const specs: Record<string, AgentSpecV2 | undefined> = { a: specWith([WEBHOOK]) };
    const { host, events } = makeHost(specs);
    await host.start();
    expect(host.triggersOf('a')).toHaveLength(1);

    specs.a = specWith([WEBHOOK, CRON]);
    events.publish({ type: 'agent.changed', agentId: 'a', reason: 'save' });
    await flush();
    await flush();

    expect(host.triggersOf('a').map((t) => t.id)).toEqual(['t1', 'c1']);
  });

  it('cancels a queued run and a running one', async () => {
    const { host, runs } = makeHost({ a: specWith([WEBHOOK, CRON]) });
    await host.start();
    const abort = vi.spyOn(runs, 'abort');

    host.dispatch({ agentId: 'a', triggerId: 't1', input: 'one', event: {} });
    const d2 = host.dispatch({ agentId: 'a', triggerId: 'c1', input: 'two', event: {} });
    await flush();

    const queued = host.runsOf('a').find((r) => r.status === 'queued');
    expect(host.cancel(queued!.runKey, 'test')).toBe('queued');
    expect(host.runsOf('a')).toHaveLength(1);

    const running = host.runsOf('a')[0];
    expect(host.cancel(running.runKey, 'test')).toBe('running');
    expect(abort).toHaveBeenCalledWith('a', 'test');
    expect(d2.ok).toBe(true);
    expect(host.cancel('missing:key', 'x')).toBeUndefined();
  });
});
