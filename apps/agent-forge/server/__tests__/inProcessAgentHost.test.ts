/**
 * `InProcessAgentHost` (server/host/inProcessAgentHost.ts): the AgentHost
 * RunManager runs specs through. Covers the host event stream (agent
 * events, span start/end, settled/failed), the ask-permission pause and
 * resolveApproval continuation, abort of live and paused runs, and one
 * RunManager case built with a `FakeAgentHost` proving run/approve/stop go
 * through the host only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentSpecV2 } from 'lousho';
import { InProcessAgentHost } from '../host/inProcessAgentHost';
import {
  HostRunNotActiveError,
  type AgentHost,
  type HostEvent,
  type HostRun,
  type HostRunInput,
} from '../host/agentHost';
import { RunManager } from '../runRegistry';
import { FileApprovalStore } from '../approvalStore';
import { FileCheckpointStore } from '../checkpointStore';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'host-agent',
  model: 'mock/mock-1',
  instructions: 'You are a helpful agent.',
};
const GATED: AgentSpecV2 = {
  ...SPEC,
  tools: [{ builtin: 'current_date' }],
  permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
};

describe('InProcessAgentHost', () => {
  let baseDir: string;
  let host: InProcessAgentHost;
  let events: HostEvent[];
  let approvalStore: FileApprovalStore;
  const onEvent = (event: HostEvent) => events.push(event);

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-host-'));
    approvalStore = new FileApprovalStore(baseDir);
    host = new InProcessAgentHost({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore,
    });
    events = [];
  });

  afterEach(async () => {
    await host.dispose();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const input = (over: Partial<HostRunInput>): HostRunInput => ({
    agentId: 'a1',
    spec: SPEC,
    sessionId: 'a1',
    input: 'hi',
    onEvent,
    ...over,
  });

  const settled = async (n = 1, timeoutMs = 3000) => {
    const start = Date.now();
    while (events.filter((e) => e.type === 'settled' || e.type === 'failed').length < n) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for settled #${n}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return events.filter((e) => e.type === 'settled' || e.type === 'failed');
  };

  it('start emits agent events, at least one span start+end, and a final settled', async () => {
    const { runId, modelLabel } = await host.start(input({}));
    expect(runId).toBeTruthy();
    expect(modelLabel).toBe('mock/mock-1');
    const finals = await settled();
    expect(finals[0]).toMatchObject({ type: 'settled', result: { finishReason: 'stop' } });
    expect(events.some((e) => e.type === 'agent')).toBe(true);
    const spans = events.filter((e) => e.type === 'span');
    expect(spans.some((e) => e.type === 'span' && e.phase === 'start')).toBe(true);
    expect(spans.some((e) => e.type === 'span' && e.phase === 'end')).toBe(true);
  });

  it('an ask permission settles with pendingApproval; resolveApproval continues to a second settled', async () => {
    const { runId } = await host.start(input({ spec: GATED, input: 'please use current_date' }));
    const finals = await settled();
    if (finals[0].type !== 'settled') throw new Error('expected settled');
    expect(finals[0].result.finishReason).toBe('awaiting-approval');
    expect(finals[0].result.pendingApproval?.toolName).toBe('current_date');

    await host.resolveApproval(runId, finals[0].result.approvalId!, { approved: true });
    const all = await settled(2);
    if (all[1].type !== 'settled') throw new Error('expected settled');
    expect(all[1].result.finishReason).not.toBe('awaiting-approval');
  });

  it('resolveApproval on a run not paused on that id throws HostRunNotActiveError', async () => {
    const { runId } = await host.start(input({}));
    await settled();
    await expect(host.resolveApproval(runId, 'nope', { approved: true })).rejects.toBeInstanceOf(
      HostRunNotActiveError
    );
  });

  it('abort of a live run settles with finishReason aborted', async () => {
    const { runId } = await host.start(input({ input: 'please use current_date', spec: { ...SPEC, tools: [{ builtin: 'current_date' }] } }));
    await host.abort(runId, 'user');
    const finals = await settled();
    expect(finals[0]).toMatchObject({ type: 'settled', result: { finishReason: 'aborted' } });
  });

  it('abort of a paused run deletes the pause file and emits no event', async () => {
    const { runId } = await host.start(input({ spec: GATED, input: 'please use current_date' }));
    const finals = await settled();
    const approvalId = finals[0].type === 'settled' ? finals[0].result.approvalId! : '';
    const before = events.length;
    await host.abort(runId);
    expect(await approvalStore.peek('a1', approvalId)).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(before);
    await expect(host.resolveApproval(runId, approvalId, { approved: true })).rejects.toBeInstanceOf(
      HostRunNotActiveError
    );
  });

  it('steer returns the steer id and a steer.joined HostEvent arrives when it lands', async () => {
    // The delay hook keeps the run live long enough for steer() to land
    // while it is mid-generate (a completed run would be
    // HostRunNotActiveError instead).
    const { runId } = await host.start(
      input({
        input: 'hi',
        extraHooks: [
          { name: 'window', preGenerate: () => new Promise((r) => setTimeout(r, 60)) },
        ],
      })
    );
    const result = await host.steer(runId, 'also remember this');
    expect(result.id).toBeTruthy();
    const start = Date.now();
    while (!events.some((e) => e.type === 'steer.joined' && e.steerId === result.id)) {
      if (Date.now() - start > 3000) throw new Error('timed out waiting for steer.joined');
      await new Promise((r) => setTimeout(r, 10));
    }
    await settled();
  });

  it('answerQuestion resumes a paused run (spec v2 cannot name the ask_question builtin, so the pause is an ask-permission one; streamAnswer resolves it as approved with the answer as the note)', async () => {
    const { runId } = await host.start(input({ spec: GATED, input: 'please use current_date' }));
    const finals = await settled();
    if (finals[0].type !== 'settled') throw new Error('expected settled');
    expect(finals[0].result.finishReason).toBe('awaiting-approval');

    await host.answerQuestion(runId, finals[0].result.approvalId!, 'the answer is 42');
    const all = await settled(2);
    if (all[1].type !== 'settled') throw new Error('expected settled');
    expect(all[1].result.finishReason).not.toBe('awaiting-approval');
  });

  it('catalog returns the SDK\'s tool/model/guardrail/trigger lists', async () => {
    const catalog = await host.catalog();
    expect(catalog.tools.length).toBeGreaterThan(0);
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.guardrails.length).toBeGreaterThan(0);
    expect(catalog.triggers.length).toBeGreaterThan(0);
  });
});

describe('RunManager on a FakeAgentHost', () => {
  it('run -> approve -> stop go through the host only', async () => {
    const calls: string[] = [];
    let onEvent: HostRunInput['onEvent'] = () => {};
    const fake: AgentHost = {
      kind: 'bridge',
      sdkVersion: '0.0.0-fake',
      start: async (i) => {
        calls.push('start');
        onEvent = i.onEvent;
        // setTimeout, not queueMicrotask: a real run can only settle after
        // start() resolves, and RunManager must see its 'running' entry
        // first (a microtask would beat the setEntry that follows await).
        setTimeout(() => {
          onEvent({ type: 'settled', result: { finishReason: 'awaiting-approval', text: '', messages: [], usage: {}, steps: 1, approvalId: 'ap-1', pendingApproval: { id: 'ap-1', toolCallId: 'c', toolName: 't', args: {}, createdAt: 'now' } } as never });
        }, 0);
        return { runId: 'r1', modelLabel: 'mock/mock-1' } satisfies HostRun;
      },
      steer: async () => ({ id: 's1', applied: 'queued' }),
      abort: async () => {
        calls.push('abort');
      },
      resolveApproval: async () => {
        calls.push('resolveApproval');
      },
      answerQuestion: async () => {},
      catalog: async () => ({ tools: [], models: [], guardrails: [], triggers: [] }),
      dispose: async () => {},
    };
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-fake-'));
    try {
      const runs = new RunManager({
        baseDir,
        checkpointStore: new FileCheckpointStore(baseDir),
        approvalStore: new FileApprovalStore(baseDir),
        host: fake,
        loadSpec: async () => undefined,
      });
      await runs.run('a1', 'hi', SPEC);
      await new Promise((r) => setTimeout(r, 30));
      expect(runs.status('a1').status).toBe('paused');
      await runs.approve('a1', 'ap-1', true);
      expect(runs.status('a1').status).toBe('running');
      // The paused->running path means stop() aborts via the host.
      runs.stop('a1');
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toEqual(['start', 'resolveApproval', 'abort']);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
