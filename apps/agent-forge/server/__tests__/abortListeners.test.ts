import { describe, expect, it, vi } from 'vitest';
import type { AgentSpecV2 } from '@linuxdevil/lousho';

import { applyAbortListeners, type AbortListenerInput } from '../triggers/abortListeners';
import type { HostRun } from '../triggers/triggerHost';

const AGENT = 'agent1';

function run(overrides: Partial<HostRun> = {}): HostRun {
  return {
    runKey: 't1:r1',
    agentId: AGENT,
    triggerId: 't1',
    event: { pr: 7, action: 'opened' },
    input: 'review pr 7',
    status: 'queued',
    enqueuedAt: '2026-11-12T00:00:00.000Z',
    ...overrides,
  };
}

function specWith(listeners: NonNullable<AgentSpecV2['abortListeners']>): AgentSpecV2 {
  return {
    version: 2,
    name: 'reviewer',
    model: 'anthropic/claude-sonnet-5-5',
    instructions: 'Review.',
    triggers: [{ id: 't1', type: 'webhook', path: '/review', promptTemplate: 'Review {{event.pr}}' }],
    abortListeners: listeners,
  } as AgentSpecV2;
}

/** A fake host: `runs` are what runsOf returns; `cancel` records calls, reports the run's live status and drops cancelled queued runs like the real host. */
function fakeHost(runs: HostRun[]) {
  const cancelled: Array<{ runKey: string; reason: string }> = [];
  const host = {
    runsOf: () => runs,
    cancel: (runKey: string, reason: string) => {
      const found = runs.find((r) => r.runKey === runKey);
      if (found === undefined) return undefined;
      cancelled.push({ runKey, reason });
      if (found.status === 'queued') runs.splice(runs.indexOf(found), 1);
      return found.status;
    },
  };
  return { host, cancelled };
}

function inputFor(
  spec: AgentSpecV2,
  host: AbortListenerInput['host'],
  event: unknown,
  log = vi.fn()
): { input: AbortListenerInput; log: ReturnType<typeof vi.fn> } {
  return {
    input: { spec, agentId: AGENT, triggerId: 't1', event, host, log },
    log,
  };
}

describe('applyAbortListeners', () => {
  const closed = { pr: 7, action: 'closed' };
  const listener = {
    id: 'l1',
    triggerId: 't1',
    when: "event.action == 'closed'",
    match: 'run.event.pr == event.pr',
    scope: 'both' as const,
  };

  it('cancels the matching queued run and reports the outcome', () => {
    const { host, cancelled } = fakeHost([run()]);
    const { input } = inputFor(specWith([listener]), host, closed);

    const outcomes = applyAbortListeners(input);

    expect(cancelled).toEqual([{ runKey: 't1:r1', reason: 'abort_listener:l1' }]);
    expect(outcomes).toEqual([{ listenerId: 'l1', cancelled: [{ runKey: 't1:r1', status: 'queued' }] }]);
  });

  it('leaves a run for a different PR alone (match scope)', () => {
    const { host, cancelled } = fakeHost([run({ event: { pr: 8, action: 'opened' } })]);
    const { input } = inputFor(specWith([listener]), host, closed);

    expect(applyAbortListeners(input)).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it('scope queued never stops a running run; scope running never drops a queued one', () => {
    const running = run({ runKey: 't1:r2', status: 'running' });
    const queuedOnly = { ...listener, id: 'lq', scope: 'queued' as const };
    const { host: h1, cancelled: c1 } = fakeHost([running]);
    expect(applyAbortListeners(inputFor(specWith([queuedOnly]), h1, closed).input)).toEqual([]);
    expect(c1).toEqual([]);

    const queued = run({ runKey: 't1:r3' });
    const runningOnly = { ...listener, id: 'lr', scope: 'running' as const };
    const { host: h2, cancelled: c2 } = fakeHost([queued]);
    expect(applyAbortListeners(inputFor(specWith([runningOnly]), h2, closed).input)).toEqual([]);
    expect(c2).toEqual([]);
  });

  it('only cancels runs of the watched trigger', () => {
    const other = run({ runKey: 't2:r1', triggerId: 't2', event: { pr: 7 } });
    const { host, cancelled } = fakeHost([other]);
    const { input } = inputFor(specWith([listener]), host, closed);

    expect(applyAbortListeners(input)).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it('does not fire when `when` is not strictly true', () => {
    const truthy = { ...listener, when: "'yes'" };
    const { host, cancelled } = fakeHost([run()]);
    const { input } = inputFor(specWith([truthy]), host, closed);

    expect(applyAbortListeners(input)).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it('logs and skips a listener whose expression fails at run time', () => {
    const bad = { ...listener, when: 'event..broken' };
    const { host, cancelled } = fakeHost([run()]);
    const { input, log } = inputFor(specWith([bad]), host, closed);

    expect(applyAbortListeners(input)).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(log).toHaveBeenCalledWith(AGENT, expect.stringContaining('Abort listener l1 failed:'), 'warn');
  });

  it('evaluates every listener independently and logs each cancel', () => {
    const second = { ...listener, id: 'l2', when: "event.action == 'closed' && event.pr == 7" };
    const { host } = fakeHost([run()]);
    const { input, log } = inputFor(specWith([listener, second]), host, closed);

    const outcomes = applyAbortListeners(input);

    // The first listener's cancel drops the queued run, so the second
    // listener finds no candidates and reports nothing.
    expect(outcomes.map((o) => o.listenerId)).toEqual(['l1']);
    expect(log).toHaveBeenCalledWith(AGENT, 'Run cancelled by abort listener l1: event.action == \'closed\'', 'warn');
  });

  it('does nothing for an agent without listeners', () => {
    const { host, cancelled } = fakeHost([run()]);
    const spec = specWith([]);
    delete spec.abortListeners;
    const { input } = inputFor(spec, host, closed);

    expect(applyAbortListeners(input)).toEqual([]);
    expect(cancelled).toEqual([]);
  });
});
