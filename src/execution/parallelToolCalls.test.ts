/**
 * LOU-V3: the tool calls of one model turn run concurrently (up to
 * `toolConcurrency`), while the transcript, approvals, failures, aborts and
 * checkpoints stay deterministic.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AgentExecutor, ExecutionEvent, ExecuteOptions, PropagatingToolError } from './AgentExecutor';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import type { Checkpoint, CheckpointStore } from './checkpoint';
import { resumeAfterApproval } from './resume';
import { createAgent } from '../createAgent';
import { defineTool, DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, MockToolCall } from '../testing';
import { AgentConfig } from '../types';
import type { Message } from '../providers';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A tool whose result the test releases by hand, recording start/end into `log`. */
function controllableTool(name: string, log: string[]) {
  const started = deferred();
  const release = deferred<string>();
  const tool = defineTool({
    name,
    description: name,
    input: z.object({}),
    execute: async () => {
      log.push(`start:${name}`);
      started.resolve();
      const value = await release.promise;
      log.push(`end:${name}`);
      return value;
    },
  });
  return { tool, started: started.promise, release };
}

function instantTool(name: string, log: string[], extra: { needsApproval?: boolean } = {}) {
  return defineTool({
    name,
    description: name,
    input: z.object({}),
    ...extra,
    execute: async () => {
      log.push(`start:${name}`);
      log.push(`end:${name}`);
      return `${name} done`;
    },
  });
}

function agentFor(tools: DefinedTool[]): AgentConfig {
  const config: AgentConfig['tools'] = {};
  for (const t of tools) config[t.name] = { tool: t.name };
  return { id: 'agent-1', name: 'Agent', prompt: 'p', tools: config };
}

function registryOf(tools: DefinedTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerMany(tools);
  return registry;
}

function callsTo(...names: string[]): MockToolCall[] {
  return names.map((name) => ({ name, id: `call_${name}` }));
}

/** Runs one turn calling `names` (in order), then a final text turn. */
function run(tools: DefinedTool[], names: string[], extra: Partial<ExecuteOptions> = {}) {
  const events: ExecutionEvent[] = [];
  const result = AgentExecutor.execute({
    agent: agentFor(tools),
    input: 'go',
    provider: mockModel([{ toolCalls: callsTo(...names) }, 'all done']),
    toolRegistry: registryOf(tools),
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { result, events };
}

function toolMessageIds(messages: readonly Message[]): Array<string | undefined> {
  return messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
}

function eventTrace(events: ExecutionEvent[]): string[] {
  return events.flatMap((e) => {
    if (e.type === 'tool-call') return [`call:${e.toolCall?.function.name}`];
    if (e.type === 'tool-result') return [`result:${e.toolResult?.toolName}`];
    return [];
  });
}

function settledFlag(promise: Promise<unknown>): { settled: boolean } {
  const flag = { settled: false };
  promise.then(
    () => (flag.settled = true),
    () => (flag.settled = true)
  );
  return flag;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('parallel tool calls (LOU-V3)', () => {
  it('runs the calls of one turn concurrently by default', async () => {
    const log: string[] = [];
    const a = controllableTool('a', log);
    const b = controllableTool('b', log);
    const { result } = run([a.tool, b.tool], ['a', 'b']);

    // Both have started while neither has finished.
    await Promise.all([a.started, b.started]);
    expect(log).toEqual(['start:a', 'start:b']);

    a.release.resolve('A');
    b.release.resolve('B');
    expect((await result).finishReason).toBe('stop');
  });

  it('records results in call order even when they complete in reverse order', async () => {
    const log: string[] = [];
    const a = controllableTool('a', log);
    const b = controllableTool('b', log);
    const { result, events } = run([a.tool, b.tool], ['a', 'b']);
    await Promise.all([a.started, b.started]);

    b.release.resolve('B');
    await tick();
    a.release.resolve('A');
    const { messages } = await result;

    expect(log).toEqual(['start:a', 'start:b', 'end:b', 'end:a']);
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => [m.toolCallId, m.content])).toEqual([
      ['call_a', '"A"'],
      ['call_b', '"B"'],
    ]);
    // tool-call events in call order before any result; results in completion order.
    expect(eventTrace(events)).toEqual(['call:a', 'call:b', 'result:b', 'result:a']);
  });

  it('sends the next provider request with results in call order', async () => {
    const log: string[] = [];
    const a = controllableTool('a', log);
    const b = controllableTool('b', log);
    const provider = mockModel([{ toolCalls: callsTo('a', 'b') }, 'all done']);
    const agent = createAgent({ prompt: 'p', provider, tools: [a.tool, b.tool] });
    const sent = agent.send('go');
    await Promise.all([a.started, b.started]);
    b.release.resolve('B');
    await tick();
    a.release.resolve('A');
    await sent;

    expect(toolMessageIds(provider.calls[1].messages as Message[])).toEqual(['call_a', 'call_b']);
  });

  it('toolConcurrency: 1 is strictly sequential with interleaved events', async () => {
    const log: string[] = [];
    const a = controllableTool('a', log);
    const tools = [a.tool, instantTool('b', log), instantTool('c', log)];
    const { result, events } = run(tools, ['a', 'b', 'c'], { toolConcurrency: 1 });
    await a.started;
    await tick();
    expect(log).toEqual(['start:a']); // `b` waits for `a`

    a.release.resolve('A');
    await result;
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
    expect(eventTrace(events)).toEqual([
      'call:a', 'result:a', 'call:b', 'result:b', 'call:c', 'result:c',
    ]);
  });

  it('never has more calls in flight than the limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const names = ['a', 'b', 'c', 'd'];
    const delays: Record<string, number> = { a: 20, b: 5, c: 15, d: 1 };
    const tools = names.map((name) =>
      defineTool({
        name,
        description: name,
        input: z.object({}),
        execute: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, delays[name]));
          inFlight--;
          return name;
        },
      })
    );
    const { result } = run(tools, names, { toolConcurrency: 2 });
    const { messages } = await result;

    expect(maxInFlight).toBe(2);
    expect(toolMessageIds(messages)).toEqual(['call_a', 'call_b', 'call_c', 'call_d']);
  });

  it('a failing tool does not affect its siblings', async () => {
    const log: string[] = [];
    const broken = defineTool({
      name: 'broken',
      description: 'always throws',
      input: z.object({}),
      execute: async (): Promise<string> => {
        throw new Error('kaput');
      },
    });
    const { result } = run([broken, instantTool('ok', log)], ['broken', 'ok']);
    const { messages, finishReason } = await result;

    expect(finishReason).toBe('stop');
    const [brokenMsg, okMsg] = messages.filter((m) => m.role === 'tool');
    expect(brokenMsg).toMatchObject({ toolCallId: 'call_broken', isError: true });
    expect(JSON.parse(brokenMsg.content)).toMatchObject({ message: 'kaput' });
    expect(okMsg).toMatchObject({ toolCallId: 'call_ok', content: '"ok done"' });
    expect(okMsg.isError).toBeUndefined();
  });

  it('a propagating error waits for running siblings, starts no new calls, then rejects', async () => {
    const log: string[] = [];
    const fatal = controllableTool('fatal', log);
    const slow = controllableTool('slow', log);
    const neverExecute = vi.fn(async () => 'never');
    const queued = defineTool({ name: 'queued', description: 'q', input: z.object({}), execute: neverExecute });
    const { result, events } = run([fatal.tool, slow.tool, queued], ['fatal', 'slow', 'queued'], {
      toolConcurrency: 2,
    });
    const settled = settledFlag(result);
    await Promise.all([fatal.started, slow.started]);

    fatal.release.reject(new PropagatingToolError('stop everything'));
    await tick();
    expect(settled.settled).toBe(false); // still waiting for `slow`

    slow.release.resolve('slow done');
    await expect(result).rejects.toThrow('stop everything');
    expect(log).toContain('end:slow');
    expect(neverExecute).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('an abort mid-batch keeps finished results and cancels the rest', async () => {
    const controller = new AbortController();
    const log: string[] = [];
    const finisher = controllableTool('finisher', log);
    const listenerStarted = deferred();
    const listener = defineTool({
      name: 'listener',
      description: 'honors the abort signal',
      input: z.object({}),
      execute: (_args, { abortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          abortSignal?.addEventListener('abort', () => reject(abortSignal.reason));
          listenerStarted.resolve();
        }),
    });
    const neverExecute = vi.fn(async () => 'never');
    const queued = defineTool({ name: 'queued', description: 'q', input: z.object({}), execute: neverExecute });
    const { result } = run([finisher.tool, listener, queued], ['finisher', 'listener', 'queued'], {
      toolConcurrency: 2,
      signal: controller.signal,
    });
    await Promise.all([finisher.started, listenerStarted.promise]);

    controller.abort();
    finisher.release.resolve('finished anyway');
    const { finishReason, messages } = await result;

    expect(finishReason).toBe('aborted');
    expect(neverExecute).not.toHaveBeenCalled();
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(['call_finisher', 'call_listener', 'call_queued']);
    expect(toolMessages[0].content).toBe('"finished anyway"');
    expect(toolMessages[1].isError).toBe(true);
    expect(JSON.parse(toolMessages[2].content)).toMatchObject({ kind: 'not-run', message: expect.stringContaining('cancelled') });
  });

  it('checkpoints only the in-order prefix of finished calls', async () => {
    const saved: Array<Array<string | undefined>> = [];
    const checkpoints = new Map<string, Checkpoint>();
    const checkpointStore: CheckpointStore = {
      async save(sessionId, checkpoint) {
        saved.push(toolMessageIds(checkpoint.messages));
        checkpoints.set(sessionId, checkpoint);
      },
      async load(sessionId) {
        return checkpoints.get(sessionId) ?? null;
      },
      async delete(sessionId) {
        checkpoints.delete(sessionId);
      },
    };
    const log: string[] = [];
    const a = controllableTool('a', log);
    const b = controllableTool('b', log);
    const { result } = run([a.tool, b.tool], ['a', 'b'], { sessionId: 's1', checkpointStore });
    await Promise.all([a.started, b.started]);

    // LOU-U9: the model's turn itself is checkpointed before any call starts.
    expect(saved).toEqual([[]]);

    b.release.resolve('B');
    await tick();
    expect(saved).toEqual([[]]); // `b` finished, but `a` (before it) has not

    a.release.resolve('A');
    await result;
    // Then the in-order prefix once, then the 'finished' checkpoint (LOU-U8).
    expect(saved).toEqual([[], ['call_a', 'call_b'], ['call_a', 'call_b']]);
  });

  describe('approval inside a batch', () => {
    function createApprovalStore(): ApprovalStore & { snapshots: ExecutionSnapshot[] } {
      const records = new Map<string, { pending: PendingApproval; snapshot: ExecutionSnapshot }>();
      const snapshots: ExecutionSnapshot[] = [];
      return {
        snapshots,
        save: async (pending, snapshot) => {
          snapshots.push(snapshot);
          records.set(pending.id, { pending, snapshot });
        },
        resolve: async (id) => records.get(id) ?? null,
      };
    }

    it.each([0, 1, 2])('pauses at the approval call in position %i; earlier calls run once', async (position) => {
      const names = ['t0', 't1', 't2'];
      const runs: Record<string, number> = { t0: 0, t1: 0, t2: 0 };
      const tools = names.map((name, index) =>
        defineTool({
          name,
          description: name,
          input: z.object({}),
          needsApproval: index === position,
          execute: async () => {
            runs[name]++;
            return `${name} done`;
          },
        })
      );
      const approvalStore = createApprovalStore();
      const toolRegistry = registryOf(tools);
      const agent = agentFor(tools);

      const paused = await AgentExecutor.execute({
        agent,
        input: 'go',
        provider: mockModel([{ toolCalls: callsTo(...names) }]),
        toolRegistry,
        approvalStore,
      });

      expect(paused.finishReason).toBe('awaiting-approval');
      const before = names.slice(0, position);
      expect(names.filter((n) => runs[n] === 1)).toEqual(before);
      expect(toolMessageIds(paused.messages)).toEqual(before.map((n) => `call_${n}`));
      const [snapshot] = approvalStore.snapshots;
      expect(snapshot.pendingToolCall.toolCallId).toBe(`call_${names[position]}`);
      expect(toolMessageIds(snapshot.currentMessages)).toEqual(before.map((n) => `call_${n}`));

      const resumed = await resumeAfterApproval(
        { id: paused.approvalId!, approved: true },
        approvalStore,
        toolRegistry,
        mockModel(['all done'])
      );

      expect(resumed.finishReason).toBe('stop');
      // The approved call ran once; calls before it were not re-executed.
      for (const name of [...before, names[position]]) expect(runs[name]).toBe(1);
      // LOU-U7: calls after the approval call run on resume, exactly once,
      // and every call of the turn ends up with one result, in call order.
      for (const name of names.slice(position + 1)) expect(runs[name]).toBe(1);
      expect(toolMessageIds(resumed.messages)).toEqual(names.map((n) => `call_${n}`));
    });
  });

  describe('toolConcurrency validation', () => {
    it.each([0, -1, 1.5, Number.NaN, 'all'])('rejects %s with a clear error', async (value) => {
      const options = {
        agent: agentFor([]),
        input: 'go',
        provider: mockModel(['hi']),
        toolConcurrency: value as ExecuteOptions['toolConcurrency'],
      };
      await expect(AgentExecutor.execute(options)).rejects.toThrow(
        /'toolConcurrency' must be a positive integer or 'unbounded'/
      );
      expect(() =>
        createAgent({ prompt: 'p', provider: mockModel([]), toolConcurrency: options.toolConcurrency })
      ).toThrow(/createAgent: 'toolConcurrency'/);
    });

    it('createAgent passes toolConcurrency through', async () => {
      const log: string[] = [];
      const a = controllableTool('a', log);
      const agent = createAgent({
        prompt: 'p',
        provider: mockModel([{ toolCalls: callsTo('a', 'b') }, 'done']),
        tools: [a.tool, instantTool('b', log)],
        toolConcurrency: 1,
      });
      const sent = agent.send('go');
      await a.started;
      await tick();
      expect(log).toEqual(['start:a']);

      a.release.resolve('A');
      await sent;
      expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    });
  });
});
