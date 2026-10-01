/**
 * Durable execution gaps:
 * - LOU-U7: an approval in the middle of a tool batch keeps the transcript valid.
 * - LOU-U8: resuming a session with new input (unfinished / finished / awaiting approval).
 * - LOU-U9: a checkpoint after every model turn, so a crash never re-calls the model.
 *
 * Every checkpoint goes through the real KVCheckpointStore (JSON round-trip)
 * and every approval snapshot through a JSON round-trip, as a real store would.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentExecutor, ExecuteOptions, ExecutionResult, PropagatingToolError } from './AgentExecutor';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import type { Checkpoint, CheckpointStore } from './checkpoint';
import { SessionAwaitingApprovalError } from './errors';
import { resumeAfterApproval } from './resume';
import { newSessionMessages } from './transcript';
import { KVCheckpointStore } from '../deploy/kvCheckpointStore';
import { defineTool, DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, MockTurn } from '../testing';
import { AgentConfig } from '../types';
import type { Message } from '../providers';

type Runs = Record<string, number>;

interface ToolOptions {
  needsApproval?: boolean;
  /** Throw a non-recoverable error (a simulated process death) on the first run. */
  crashOnce?: boolean;
  input?: z.ZodObject<z.ZodRawShape>;
  seenIds?: string[];
}

function tool(name: string, runs: Runs, options: ToolOptions = {}): DefinedTool {
  runs[name] = 0;
  return defineTool({
    name,
    description: name,
    input: options.input ?? z.object({}),
    needsApproval: options.needsApproval,
    execute: async (_args, ctx) => {
      runs[name]++;
      options.seenIds?.push(ctx.toolCallId);
      if (options.crashOnce && runs[name] === 1) {
        throw new PropagatingToolError(`process died while running ${name}`);
      }
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

function turnCalling(...names: string[]): MockTurn {
  return { toolCalls: names.map((name) => ({ name, id: `call_${name}` })) };
}

function toolIds(messages: readonly Message[]): Array<string | undefined> {
  return messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
}

function roles(messages: readonly Message[]): string[] {
  return messages.map((m) => m.role);
}

/** A KVCheckpointStore over a Map, optionally failing the n-th save (1-based). */
function checkpointStore(failSave?: number): KVCheckpointStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  let saves = 0;
  const store = new KVCheckpointStore({
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => {
      saves++;
      if (saves === failSave) throw new Error('disk gone');
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
  });
  return Object.assign(store, { data });
}

/** An ApprovalStore that JSON round-trips its records, like a real one. */
function approvalStore(): ApprovalStore & { snapshots: ExecutionSnapshot[]; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  const snapshots: ExecutionSnapshot[] = [];
  return {
    raw,
    snapshots,
    async save(pending: PendingApproval, snapshot: ExecutionSnapshot) {
      snapshots.push(JSON.parse(JSON.stringify(snapshot)) as ExecutionSnapshot);
      raw.set(pending.id, JSON.stringify({ pending, snapshot }));
    },
    async resolve(id: string) {
      const record = raw.get(id);
      raw.delete(id);
      return record ? JSON.parse(record) : null;
    },
  };
}

interface Harness {
  tools: DefinedTool[];
  checkpoints?: CheckpointStore;
  approvals?: ApprovalStore;
}

function execute(h: Harness, script: MockTurn[], extra: Partial<ExecuteOptions> = {}) {
  const model = mockModel(script);
  const result = AgentExecutor.execute({
    agent: agentFor(h.tools),
    input: 'go',
    provider: model,
    toolRegistry: registryOf(h.tools),
    approvalStore: h.approvals,
    checkpointStore: h.checkpoints,
    sessionId: h.checkpoints ? 's1' : undefined,
    ...extra,
  });
  return { model, result };
}

async function resume(h: Harness, paused: ExecutionResult, script: MockTurn[], approved = true) {
  const model = mockModel(script);
  const result = await resumeAfterApproval(
    { id: paused.approvalId!, approved, note: approved ? undefined : 'not today' },
    h.approvals!,
    registryOf(h.tools),
    model,
    {},
    h.checkpoints
  );
  return { model, result };
}

describe('LOU-U7: approval in the middle of a tool batch', () => {
  it('approved: the paused call and the calls after it each run once, every call has one result in call order', async () => {
    const runs: Runs = {};
    const h: Harness = {
      tools: [tool('a', runs), tool('b', runs, { needsApproval: true }), tool('c', runs)],
      approvals: approvalStore(),
    };
    const paused = await execute(h, [turnCalling('a', 'b', 'c')]).result;
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(runs).toEqual({ a: 1, b: 0, c: 0 });
    const [snapshot] = (h.approvals as ReturnType<typeof approvalStore>).snapshots;
    expect(snapshot.remainingToolCalls?.map((c) => c.id)).toEqual(['call_c']);

    const { model, result } = await resume(h, paused, ['all done']);

    expect(result.text).toBe('all done');
    expect(runs).toEqual({ a: 1, b: 1, c: 1 });
    expect(toolIds(result.messages)).toEqual(['call_a', 'call_b', 'call_c']);
    // The model is called once, with a complete, provider-valid turn.
    expect(model.calls).toHaveLength(1);
    expect(toolIds(model.calls[0].messages as Message[])).toEqual(['call_a', 'call_b', 'call_c']);
  });

  it('rejected: the paused call gets a structured rejection result and the remaining calls still run', async () => {
    const runs: Runs = {};
    const h: Harness = {
      tools: [tool('a', runs), tool('b', runs, { needsApproval: true }), tool('c', runs)],
      approvals: approvalStore(),
    };
    const paused = await execute(h, [turnCalling('a', 'b', 'c')]).result;

    const { result } = await resume(h, paused, ['ok, skipped b'], false);

    expect(runs).toEqual({ a: 1, b: 0, c: 1 });
    const [, rejected, c] = result.messages.filter((m) => m.role === 'tool');
    expect(rejected).toMatchObject({ toolCallId: 'call_b', isError: true });
    expect(JSON.parse(rejected.content)).toMatchObject({ kind: 'rejected', message: expect.stringContaining('rejected'), note: 'not today' });
    expect(c).toMatchObject({ toolCallId: 'call_c', content: '"c done"' });
  });

  it('a remaining call that needs approval pauses again; the chain completes with no call run twice', async () => {
    const runs: Runs = {};
    const approvals = approvalStore();
    const h: Harness = {
      tools: [
        tool('a', runs),
        tool('b', runs, { needsApproval: true }),
        tool('c', runs, { needsApproval: true }),
        tool('d', runs),
      ],
      approvals,
    };
    const first = await execute(h, [turnCalling('a', 'b', 'c', 'd')]).result;

    const second = await resume(h, first, []);
    expect(second.result.finishReason).toBe('awaiting-approval');
    expect(second.result.approvalId).not.toBe(first.approvalId);
    expect(second.model.calls).toHaveLength(0);
    expect(approvals.snapshots[1].pendingToolCall.toolCallId).toBe('call_c');
    expect(approvals.snapshots[1].remainingToolCalls?.map((c) => c.id)).toEqual(['call_d']);
    expect(toolIds(approvals.snapshots[1].currentMessages)).toEqual(['call_a', 'call_b']);

    const third = await resume(h, second.result, ['finished']);
    expect(third.result.text).toBe('finished');
    expect(runs).toEqual({ a: 1, b: 1, c: 1, d: 1 });
    expect(toolIds(third.result.messages)).toEqual(['call_a', 'call_b', 'call_c', 'call_d']);
  });

  it('a remaining call with invalid arguments gets its validation error result', async () => {
    const runs: Runs = {};
    const h: Harness = {
      tools: [tool('b', runs, { needsApproval: true }), tool('c', runs, { input: z.object({ n: z.number() }) })],
      approvals: approvalStore(),
    };
    const paused = await execute(h, [turnCalling('b', 'c')]).result;

    const { result } = await resume(h, paused, ['done']);

    expect(runs).toEqual({ b: 1, c: 0 });
    const c = result.messages.find((m) => m.toolCallId === 'call_c');
    expect(c?.isError).toBe(true);
    expect(toolIds(result.messages)).toEqual(['call_b', 'call_c']);
  });

  it('a snapshot saved without remainingToolCalls (older SDK) resumes as before: later calls do not run, but get a result', async () => {
    const runs: Runs = {};
    const approvals = approvalStore();
    const h: Harness = {
      tools: [tool('a', runs), tool('b', runs, { needsApproval: true }), tool('c', runs)],
      approvals,
    };
    const paused = await execute(h, [turnCalling('a', 'b', 'c')]).result;
    const record = JSON.parse(approvals.raw.get(paused.approvalId!)!);
    delete record.snapshot.remainingToolCalls;
    approvals.raw.set(paused.approvalId!, JSON.stringify(record));

    const { result } = await resume(h, paused, ['done']);

    expect(runs).toEqual({ a: 1, b: 1, c: 0 });
    expect(toolIds(result.messages)).toEqual(['call_a', 'call_b', 'call_c']);
    const c = result.messages.find((m) => m.toolCallId === 'call_c')!;
    expect(c.isError).toBe(true);
    expect(JSON.parse(c.content)).toMatchObject({ kind: 'not-run', message: expect.stringMatching(/not run/) });
  });
});

describe('LOU-U9: checkpoint after every model turn', () => {
  it("checkpoints the model's tool-call turn before any tool runs", async () => {
    const checkpoints = checkpointStore();
    let atToolStart: Checkpoint | null = null;
    const probe = defineTool({
      name: 'probe',
      description: 'reads the checkpoint',
      input: z.object({}),
      execute: async () => {
        atToolStart = await checkpoints.load('s1');
        return 'ok';
      },
    });

    await execute({ tools: [probe], checkpoints }, [turnCalling('probe'), 'done']).result;

    expect(atToolStart!.status).toBe('in-progress');
    expect(atToolStart!.messages.at(-1)).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'call_probe' }] });
  });

  it('a crash mid-tool resumes by running exactly the missing calls, without calling the model first', async () => {
    const runs: Runs = {};
    const seenIds: string[] = [];
    const checkpoints = checkpointStore();
    const h: Harness = { tools: [tool('a', runs), tool('b', runs, { crashOnce: true, seenIds })], checkpoints };

    const crashed = execute(h, [turnCalling('a', 'b'), 'never reached']);
    await expect(crashed.result).rejects.toThrow('process died');
    expect(crashed.model.calls).toHaveLength(1);

    // A fresh execute() with the same sessionId and the same request (a retry).
    const resumed = execute(h, ['all done']);
    const result = await resumed.result;

    expect(result.text).toBe('all done');
    expect(resumed.model.calls).toHaveLength(1);
    // `a`'s result was recorded before the crash, so it never runs again;
    // `b` was mid-execution, so it runs again (at-least-once) with the same id.
    expect(runs).toEqual({ a: 1, b: 2 });
    expect(seenIds).toEqual(['call_b', 'call_b']);
    expect(toolIds(resumed.model.calls[0].messages as Message[])).toEqual(['call_a', 'call_b']);
    expect(roles(result.messages).filter((r) => r === 'user')).toHaveLength(1);
  });

  it('a store failure right after the model responded resumes without re-calling the model', async () => {
    const runs: Runs = {};
    const failing = checkpointStore(2); // save 1 = the model turn, save 2 = the first tool result
    const h: Harness = { tools: [tool('a', runs)], checkpoints: failing };
    await expect(execute(h, [turnCalling('a'), 'never reached']).result).rejects.toThrow('disk gone');

    const resumed = execute(h, ['all done']);

    expect((await resumed.result).text).toBe('all done');
    expect(resumed.model.calls).toHaveLength(1);
    expect(runs.a).toBe(2);
  });
});

describe('LOU-U8: resume with new input', () => {
  it('(a) unfinished run + new input: appended after the pending tool results, never between', async () => {
    const runs: Runs = {};
    const h: Harness = { tools: [tool('a', runs), tool('b', runs, { crashOnce: true })], checkpoints: checkpointStore() };
    await expect(execute(h, [turnCalling('a', 'b')]).result).rejects.toThrow('process died');

    const resumed = execute(h, ['done'], { input: 'also check the weather' });
    const result = await resumed.result;

    const sent = resumed.model.calls[0].messages as Message[];
    expect(roles(sent)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(sent.at(-1)?.content).toBe('also check the weather');
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: 'done' });
  });

  it('(a) aborted run + new input: appended at once (interrupt and redirect)', async () => {
    const runs: Runs = {};
    const controller = new AbortController();
    const h: Harness = { tools: [tool('a', runs)], checkpoints: checkpointStore() };
    const aborted = await execute(h, [turnCalling('a')], {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'tool-result') controller.abort();
      },
    }).result;
    expect(aborted.finishReason).toBe('aborted');

    const resumed = execute(h, ['redirected'], { input: 'actually, summarize instead' });
    const result = await resumed.result;

    expect(result.text).toBe('redirected');
    expect(runs.a).toBe(1);
    const sent = resumed.model.calls[0].messages as Message[];
    expect(roles(sent)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(sent.at(-1)?.content).toBe('actually, summarize instead');
    expect(result.steps).toBe(2);
  });

  it('(b) finished run: the session continues as a conversation', async () => {
    const h: Harness = { tools: [], checkpoints: checkpointStore() };
    await execute(h, ['hello'], { input: 'hi' }).result;

    const next = execute(h, ['fine, thanks'], { input: 'how are you?' });
    const result = await next.result;

    expect((next.model.calls[0].messages as Message[]).map((m) => [m.role, m.content])).toEqual([
      ['system', 'p'],
      ['user', 'hi'],
      ['assistant', 'hello'],
      ['user', 'how are you?'],
    ]);
    expect(result.steps).toBe(1);
    expect(result.messages).toHaveLength(5);
    const stored = await h.checkpoints!.load('s1');
    expect(stored?.status).toBe('finished');
    expect(stored?.messages).toEqual(result.messages);
  });

  it('(b) a caller that re-sends the whole history does not duplicate it', async () => {
    const h: Harness = { tools: [], checkpoints: checkpointStore() };
    const first = await execute(h, ['hello'], { input: 'hi' }).result;

    const next = execute(h, ['sure'], { input: [...first.messages, { role: 'user', content: 'next' }] });
    await next.result;

    expect(roles(next.model.calls[0].messages as Message[])).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('(c) awaiting approval: execute() throws SessionAwaitingApprovalError; after resumeAfterApproval the session continues', async () => {
    const runs: Runs = {};
    const h: Harness = {
      tools: [tool('b', runs, { needsApproval: true })],
      checkpoints: checkpointStore(),
      approvals: approvalStore(),
    };
    const paused = await execute(h, [turnCalling('b')]).result;

    const blocked = execute(h, ['never'], { input: 'are you there?' });
    const error = await blocked.result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionAwaitingApprovalError);
    expect(error).toMatchObject({ sessionId: 's1', approvalId: paused.approvalId });
    expect((error as Error).message).toMatch(/resumeAfterApproval/);
    expect(blocked.model.calls).toHaveLength(0);
    expect(runs.b).toBe(0);

    await resume(h, paused, ['charged']);
    const next = execute(h, ['you are welcome'], { input: 'thanks' });
    const result = await next.result;

    expect(result.text).toBe('you are welcome');
    expect(roles(next.model.calls[0].messages as Message[])).toEqual([
      'system', 'user', 'assistant', 'tool', 'assistant', 'user',
    ]);
  });

  it('new input queued behind pending calls survives another approval pause', async () => {
    const runs: Runs = {};
    const approvals = approvalStore();
    const h: Harness = {
      tools: [tool('a', runs, { crashOnce: true }), tool('b', runs, { needsApproval: true })],
      checkpoints: checkpointStore(),
      approvals,
    };
    await expect(execute(h, [turnCalling('a', 'b')], { toolConcurrency: 1 }).result).rejects.toThrow('process died');

    const paused = await execute(h, [], { input: 'queued question' }).result;
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.messages.some((m) => m.content === 'queued question')).toBe(false);
    expect(approvals.snapshots[0].currentMessages.at(-1)).toEqual({ role: 'user', content: 'queued question' });

    const { model } = await resume(h, paused, ['answered']);

    const sent = model.calls[0].messages as Message[];
    expect(roles(sent)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(sent.at(-1)?.content).toBe('queued question');
    expect(runs).toEqual({ a: 2, b: 1 });
  });
});

describe('usage continuity across resumes (LOU-V5 x LOU-U7/U9)', () => {
  const callTurn = (...names: string[]): MockTurn => ({ ...(turnCalling(...names) as object), usage: { inputTokens: 100, outputTokens: 10 } });
  const finalTurn: MockTurn = { text: 'done', usage: { inputTokens: 200, outputTokens: 20 } };

  it('a crash-resume with pending tool calls continues the checkpointed totals', async () => {
    const runs: Runs = {};
    const h: Harness = { tools: [tool('a', runs), tool('b', runs, { crashOnce: true })], checkpoints: checkpointStore() };
    await expect(execute(h, [callTurn('a', 'b')]).result).rejects.toThrow('process died');

    const result = await execute(h, [finalTurn]).result;

    expect(result.usage).toMatchObject({ inputTokens: 300, outputTokens: 30, totalTokens: 330, modelCalls: 2 });
    expect(result.stepUsage).toHaveLength(2);
  });

  it('an approval pause -> resume with remaining calls continues the snapshotted totals', async () => {
    const runs: Runs = {};
    const h: Harness = {
      tools: [tool('a', runs), tool('b', runs, { needsApproval: true }), tool('c', runs)],
      approvals: approvalStore(),
      checkpoints: checkpointStore(),
    };
    const paused = await execute(h, [callTurn('a', 'b', 'c')]).result;
    expect(paused.usage).toMatchObject({ inputTokens: 100, outputTokens: 10, modelCalls: 1 });

    const { result } = await resume(h, paused, [finalTurn]);

    expect(runs).toEqual({ a: 1, b: 1, c: 1 });
    expect(result.usage).toMatchObject({ inputTokens: 300, outputTokens: 30, totalTokens: 330, modelCalls: 2 });
  });

  it('tool execute options carry toolCallId, abortSignal and onDelegatedUsage together', async () => {
    let seen: Record<string, unknown> = {};
    const probe = defineTool({
      name: 'probe',
      description: 'records its options',
      input: z.object({}),
      execute: async (_args, ctx) => {
        seen = { ...ctx };
        return 'ok';
      },
    });
    const controller = new AbortController();

    await execute({ tools: [probe] }, [turnCalling('probe'), 'done'], { signal: controller.signal }).result;

    expect(seen.toolCallId).toBe('call_probe');
    expect(seen.abortSignal).toBe(controller.signal);
    expect(typeof seen.onDelegatedUsage).toBe('function');
  });

  it('a new turn of a finished session counts its own usage from zero', async () => {
    const h: Harness = { tools: [], checkpoints: checkpointStore() };
    await execute(h, [finalTurn], { input: 'hi' }).result;

    const next = await execute(h, [{ text: 'again', usage: { inputTokens: 50, outputTokens: 5 } }], { input: 'more' }).result;

    expect(next.usage).toMatchObject({ inputTokens: 50, outputTokens: 5, modelCalls: 1 });
  });
});

describe('newSessionMessages (LOU-U8 input merging)', () => {
  const stored: Message[] = [
    { role: 'system', content: 'p' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: '[provider-error] {"error":"rate limited"}' },
  ];

  it('appends a repeated message to a finished conversation (it is a new turn)', () => {
    expect(newSessionMessages(stored.slice(0, 3), 'hi', true)).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('treats the starting user turn as a retry of an unfinished run, skipping provider-error notes', () => {
    expect(newSessionMessages(stored, 'hi', false)).toEqual([]);
    expect(newSessionMessages(stored, [], false)).toEqual([]);
  });

  it('appends only what follows a lagging copy of the history to an unfinished run', () => {
    const input: Message[] = [{ role: 'user', content: 'hi' }, { role: 'user', content: 'new' }];
    expect(newSessionMessages(stored, input, false)).toEqual([{ role: 'user', content: 'new' }]);
  });

  it('appends unrelated input to an unfinished run', () => {
    expect(newSessionMessages(stored, 'something else', false)).toEqual([{ role: 'user', content: 'something else' }]);
  });
});
