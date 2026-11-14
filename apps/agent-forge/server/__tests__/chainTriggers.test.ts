import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type { TriggerSpec } from '@linuxdevil/lousho/spec';

import type { AgentRepo } from '../storage/agentRepo';
import type { RunManager } from '../runRegistry';
import type { DispatchRequest, HostRun, RunEnd, TriggerHost } from '../triggers/triggerHost';
import {
  attachChainTriggers,
  chainTargets,
  validateChains,
  MAX_CHAIN_DEPTH,
  type AgentTrigger,
  type ChainEvent,
} from '../triggers/chainTriggers';

const agentTrigger = (id: string, after: string, on: AgentTrigger['on'] = 'any'): AgentTrigger => ({
  id,
  type: 'agent',
  after,
  on,
  promptTemplate: `chained after {{after}}: {{run.resultText}} ({{run.status}}, {{run.traceId}})`,
});

function spec(triggers: TriggerSpec[] = []): AgentSpecV2 {
  return { version: 2, name: 'x', triggers } as unknown as AgentSpecV2;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('chainTargets', () => {
  const specs = new Map<string, AgentSpecV2>([
    ['a', spec()],
    ['b', spec([agentTrigger('t-b', 'a', 'done')])],
    ['c', spec([agentTrigger('t-c', 'a', 'error')])],
    ['d', spec([agentTrigger('t-d', 'a', 'any')])],
    ['e', spec([agentTrigger('t-e', 'z', 'any')])],
  ]);

  it('returns only triggers whose after matches and whose on covers the status', () => {
    const done = chainTargets(specs, 'a', 'done');
    expect(done.map((t) => t.agentId).sort()).toEqual(['b', 'd']);
    const errored = chainTargets(specs, 'a', 'error');
    expect(errored.map((t) => t.agentId).sort()).toEqual(['c', 'd']);
  });
});

describe('validateChains', () => {
  it('accepts a clean two-agent chain', () => {
    const specs = new Map([['a', spec()]]);
    expect(validateChains(specs, 'b', spec([agentTrigger('t', 'a')])).ok).toBe(true);
  });

  it('rejects an unknown after target', () => {
    const specs = new Map([['a', spec()]]);
    const result = validateChains(specs, 'b', spec([agentTrigger('t', 'ghost')]));
    expect(result).toEqual({
      ok: false,
      error: "Trigger t runs after 'ghost', but there is no agent with that id.",
    });
  });

  it('rejects an agent chaining after itself', () => {
    const specs = new Map([['a', spec()]]);
    const result = validateChains(specs, 'a', spec([agentTrigger('t', 'a')]));
    expect(result).toEqual({ ok: false, error: "An agent can't run after itself." });
  });

  it('rejects a two-agent cycle with the cycle path', () => {
    // a.after = 'b' (candidate) while b.after = 'a' (stored): a -> b -> a.
    const specs = new Map([['b', spec([agentTrigger('t-b', 'a')])]]);
    const result = validateChains(specs, 'a', spec([agentTrigger('t-a', 'b')]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('These agents would start each other forever: a → b → a.');
      expect(result.cycle).toEqual(['a', 'b', 'a']);
    }
  });

  it('rejects a chain deeper than MAX_CHAIN_DEPTH agents', () => {
    // Stored a -> b -> c; candidate d chains after c: a -> b -> c -> d is 4.
    const specs = new Map([
      ['a', spec()],
      ['b', spec([agentTrigger('t-b', 'a')])],
      ['c', spec([agentTrigger('t-c', 'b')])],
    ]);
    const result = validateChains(specs, 'd', spec([agentTrigger('t-d', 'c')]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(`This chain is longer than ${MAX_CHAIN_DEPTH} agents: a → b → c → d.`);
    }
  });

  it('accepts a chain exactly MAX_CHAIN_DEPTH agents deep', () => {
    const specs = new Map([
      ['a', spec()],
      ['b', spec([agentTrigger('t-b', 'a')])],
    ]);
    expect(validateChains(specs, 'c', spec([agentTrigger('t-c', 'b')])).ok).toBe(true);
  });

  it('ignores problems that do not pass through the candidate', () => {
    // x has an orphan `after` but is unrelated to candidate b's save.
    const specs = new Map([
      ['a', spec()],
      ['x', spec([agentTrigger('t-x', 'ghost')])],
    ]);
    expect(validateChains(specs, 'b', spec([agentTrigger('t-b', 'a')])).ok).toBe(true);
  });
});

/** RunEnd/HostRun fixtures for the runtime half. */
function hostRun(agentId: string, runKey = `rk-${agentId}`): HostRun {
  return { runKey, agentId, triggerId: 't', event: {}, input: 'in', status: 'running', enqueuedAt: '2026-01-01T00:00:00.000Z' };
}

function runEnd(agentId: string, status: RunEnd['status'], extra: Partial<RunEnd> = {}): RunEnd {
  return {
    run: hostRun(agentId),
    status,
    resultText: `${agentId} result`,
    traceId: `trace-${agentId}`,
    cancelled: false,
    ...extra,
  };
}

function fakeHost() {
  const endListeners: Array<(end: RunEnd) => void> = [];
  const dispatches: DispatchRequest[] = [];
  const logs: string[] = [];
  let nextKey = 0;
  const host = {
    onRunEnd: (listener: (end: RunEnd) => void) => {
      endListeners.push(listener);
      return () => {};
    },
    dispatch: vi.fn<[req: DispatchRequest], { ok: true; runKey: string; started: boolean }>((req) => {
      dispatches.push(req);
      return { ok: true, runKey: `chain-rk${++nextKey}`, started: true };
    }),
    log: (agentId: string, message: string) => logs.push(`${agentId}: ${message}`),
    triggersOf: () => [],
  } as unknown as TriggerHost;
  return {
    host,
    dispatches,
    logs,
    dispatch: host.dispatch as unknown as ReturnType<typeof vi.fn>,
    end: (end: RunEnd) => endListeners.forEach((listener) => listener(end)),
  };
}

function fakeRepo(specs: Record<string, AgentSpecV2>) {
  return {
    listIds: () => Object.keys(specs).sort(),
    readSpec: async (id: string) => specs[id],
  } as unknown as AgentRepo;
}

function make(specs: Record<string, AgentSpecV2>) {
  const fake = fakeHost();
  const runs = new EventEmitter() as unknown as RunManager;
  const detach = attachChainTriggers({ host: fake.host, repo: fakeRepo(specs), runManager: runs, log: fake.host.log });
  return { ...fake, runs, detach, emitStatus: (p: Record<string, unknown>) => runs.emit('status', p) };
}

describe('attachChainTriggers', () => {
  it('dispatches on:"done" targets when a host run ends done, with the rendered template and ChainEvent', async () => {
    const { end, dispatches } = make({
      a: spec(),
      b: spec([agentTrigger('t-b', 'a', 'done')]),
      c: spec([agentTrigger('t-c', 'a', 'error')]),
    });

    end(runEnd('a', 'done'));
    await flush();
    await flush();

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ agentId: 'b', triggerId: 't-b' });
    expect(dispatches[0].input).toBe('chained after a: a result (done, trace-a)');
    const event = dispatches[0].event as ChainEvent;
    expect(event).toMatchObject({ type: 'agent', after: 'a', chain: ['a'] });
    expect(event.run).toEqual({ status: 'done', resultText: 'a result', traceId: 'trace-a' });
  });

  it('maps error to on:"error" targets and fires nothing for a cancelled run', async () => {
    const { end, dispatches } = make({
      a: spec(),
      b: spec([agentTrigger('t-b', 'a', 'done')]),
      c: spec([agentTrigger('t-c', 'a', 'error')]),
    });

    end(runEnd('a', 'error'));
    await flush();
    await flush();
    expect(dispatches.map((d) => d.agentId)).toEqual(['c']);

    end(runEnd('a', 'done', { cancelled: true }));
    end(runEnd('a', 'stopped', { cancelled: true }));
    await flush();
    await flush();
    expect(dispatches).toHaveLength(1);
  });

  it('skips a target already in the chain and logs the loop', async () => {
    // a -> b -> a would loop: b's chain run ends and a is a target again.
    const { host, end, dispatches, logs } = make({
      a: spec([agentTrigger('t-a', 'b', 'done')]),
      b: spec([agentTrigger('t-b', 'a', 'done')]),
    });
    void host;

    end(runEnd('a', 'done')); // chain ['a'] -> dispatch to b (rk chain-rk1)
    await flush();
    await flush();
    expect(dispatches).toHaveLength(1);

    // b's chained run ends: its runKey is the dispatch result's.
    const bEnd = runEnd('b', 'done');
    bEnd.run = { ...bEnd.run, runKey: 'chain-rk1' };
    end(bEnd);
    await flush();
    await flush();

    expect(dispatches).toHaveLength(1); // a was skipped: it is already in the chain
    expect(logs.some((l) => l.includes('would loop'))).toBe(true);
  });

  it('skips dispatches past MAX_CHAIN_DEPTH agents', async () => {
    const { end, dispatches, logs } = make({
      a: spec(),
      b: spec([agentTrigger('t-b', 'a', 'done')]),
      c: spec([agentTrigger('t-c', 'b', 'done')]),
      d: spec([agentTrigger('t-d', 'c', 'done')]),
    });

    end(runEnd('a', 'done')); // -> b (rk1)
    await flush();
    await flush();
    const bEnd = runEnd('b', 'done');
    bEnd.run = { ...bEnd.run, runKey: 'chain-rk1' };
    end(bEnd); // chain ['a','b'] -> c (rk2)
    await flush();
    await flush();
    const cEnd = runEnd('c', 'done');
    cEnd.run = { ...cEnd.run, runKey: 'chain-rk2' };
    end(cEnd); // chain ['a','b','c'] length 3 -> d skipped
    await flush();
    await flush();

    expect(dispatches.map((d) => d.agentId)).toEqual(['b', 'c']);
    expect(logs.some((l) => l.includes('more than 3 agents in a row'))).toBe(true);
  });

  it('chains from a manual run seen on the RunManager status stream, once', async () => {
    const { emitStatus, dispatches } = make({
      a: spec(),
      b: spec([agentTrigger('t-b', 'a', 'done')]),
    });

    emitStatus({ agentId: 'a', status: 'running' });
    emitStatus({ agentId: 'a', status: 'done', resultText: 'manual out', traceId: 'mt', source: undefined });
    emitStatus({ agentId: 'a', status: 'done', resultText: 'manual out', traceId: 'mt' }); // duplicate emit
    await flush();
    await flush();

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].input).toBe('chained after a: manual out (done, mt)');
  });

  it('ignores trigger-owned status ends and cancelled manual runs', async () => {
    const { emitStatus, dispatches } = make({
      a: spec(),
      b: spec([agentTrigger('t-b', 'a', 'done'), agentTrigger('t-b2', 'a', 'error')]),
    });

    // A host-owned run's status events are the host's job, not ours.
    emitStatus({ agentId: 'a', status: 'running', source: 'trigger' });
    emitStatus({ agentId: 'a', status: 'done', source: 'trigger', resultText: 'x' });
    // A manual run the user stopped chains nothing.
    emitStatus({ agentId: 'a', status: 'running' });
    emitStatus({ agentId: 'a', status: 'stopped' });
    await flush();
    await flush();

    expect(dispatches).toHaveLength(0);
  });
});
