/**
 * LOU-Y1: a child agent run (the `task` tool) inherits the parent run's
 * runtime.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentExecutor, type ExecuteOptions } from './AgentExecutor';
import type { AgentEvent } from './agentEvents';
import { HookRegistry } from './hooks';
import { resumeAfterApproval } from './resume';
import type { ApprovalStore, ResolvedApproval } from './ApprovalGate';
import type { Span, TraceExporter } from './tracing';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools/ToolRegistry';
import { mockModel, type MockTurn } from '../testing';
import type { Message } from '../providers';
import { KVCheckpointStore } from '../deploy/kvCheckpointStore';
import { SessionAwaitingApprovalError } from './errors';

const lead = { name: 'lead', prompt: 'You coordinate.' };

const task = (agent: string, prompt = 'do it', id = `${agent}-call`) => ({
  name: 'task',
  args: { agent, prompt, description: `${agent} task` },
  id,
});

/** A JSON round-tripping store, so snapshots must survive serialization. */
function memoryApprovals() {
  const records = new Map<string, string>();
  const store: ApprovalStore = {
    save: async (pending, snapshot) => {
      records.set(pending.id, JSON.stringify({ pending, snapshot }));
    },
    resolve: async (id) => {
      const record = records.get(id);
      records.delete(id);
      return record ? (JSON.parse(record) as ResolvedApproval) : null;
    },
  };
  const only = (): ResolvedApproval => {
    expect(records.size).toBe(1);
    return JSON.parse([...records.values()][0]) as ResolvedApproval;
  };
  return { store, records, only };
}

function lookupTool(log: string[] = []) {
  return defineTool({
    name: 'lookup',
    description: 'Looks something up',
    input: z.object({}),
    execute: () => {
      log.push('lookup');
      return 'looked up';
    },
  });
}

/** A sub-agent with a `send` tool that needs approval; `sent` counts executions. */
function approvingChild(name: string, turns: MockTurn[]) {
  const sent: string[] = [];
  const send = defineTool({
    name: 'send',
    description: 'Sends a message',
    input: z.object({ to: z.string() }),
    needsApproval: true,
    execute: ({ to }) => {
      sent.push(to);
      return `sent to ${to}`;
    },
  });
  const model = mockModel(turns);
  const agent = createAgent({ name, provider: model, tools: [send], description: `The ${name}` });
  return { agent, model, sent };
}

function toolResults(messages: readonly Message[]): Message[] {
  return messages.filter((m) => m.role === 'tool');
}

function run(options: Omit<ExecuteOptions, 'agent' | 'input'> & { input?: string }) {
  return AgentExecutor.execute({ agent: lead, input: 'go', ...options });
}

describe('sub-agents inherit the parent runtime (LOU-Y1)', () => {
  it("runs the parent's hooks on the child's model and tool calls, tagged with ctx.subagent", async () => {
    const seen: string[] = [];
    const subagentsSeenBySecondHook: unknown[] = [];
    const hooks = new HookRegistry();
    hooks.register({
      name: 'spy',
      preGenerate: (ctx) => void seen.push(`generate@${ctx.subagent?.name ?? 'lead'}`),
      preToolCall: (ctx) => {
        const where = ctx.subagent ? `${ctx.subagent.name}:${ctx.subagent.depth}:${ctx.subagent.toolCallId}` : 'lead';
        seen.push(`${ctx.toolName}@${where}`);
      },
    });
    hooks.register({ name: 'second', preToolCall: (ctx) => void subagentsSeenBySecondHook.push(ctx.subagent) });
    const researcher = createAgent({
      name: 'researcher',
      provider: mockModel([{ toolCalls: [{ name: 'lookup' }] }, 'found']),
      tools: [lookupTool()],
      description: 'Researches',
    });

    await run({ provider: mockModel([{ toolCalls: [task('researcher')] }, 'done']), subagents: { researcher }, hooks });

    expect(seen).toEqual([
      'generate@lead',
      'task@lead',
      'generate@researcher',
      'lookup@researcher:1:researcher-call',
      'generate@researcher',
      'generate@lead',
    ]);
    // Tagged once per call, however many hooks run on it.
    expect(subagentsSeenBySecondHook[1]).toEqual({
      name: 'researcher',
      depth: 1,
      toolCallId: 'researcher-call',
      description: 'researcher task',
    });
  });

  it('a hook that throws inside a sub-agent halts the whole run', async () => {
    const halt = new Error('rate limit hit');
    const hooks = new HookRegistry();
    hooks.register({
      name: 'limiter',
      preToolCall: (ctx) => {
        if (ctx.toolName === 'lookup') throw halt;
      },
    });
    const researcher = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'lookup' }] }, 'found']),
      tools: [lookupTool()],
      description: 'Researches',
    });

    await expect(
      run({ provider: mockModel([{ toolCalls: [task('researcher')] }, 'done']), subagents: { researcher }, hooks })
    ).rejects.toBe(halt);
  });

  it("parents the child's invoke_agent span to the parent's execute_tool span", async () => {
    const spans: Span[] = [];
    const exporter: TraceExporter = { onSpanStart: (span) => spans.push(span), onSpanEnd: () => undefined };
    const researcher = createAgent({ name: 'researcher', provider: mockModel(['found']), description: 'Researches' });

    await run({ provider: mockModel([{ toolCalls: [task('researcher')] }, 'done']), subagents: { researcher }, exporter });

    const taskSpan = spans.find((s) => s.name === 'execute_tool task');
    const childSpan = spans.find((s) => s.name === 'invoke_agent researcher');
    const leadSpan = spans.find((s) => s.name === 'invoke_agent lead');
    expect(leadSpan?.parentId).toBeUndefined();
    expect(taskSpan?.parentId).toBe(leadSpan?.id);
    expect(childSpan?.parentId).toBe(taskSpan?.id);
    expect(spans.find((s) => s.name.startsWith('chat') && s.parentId === childSpan?.id)).toBeDefined();
  });

  it("aborting the parent's signal aborts the child and the whole run", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const stop = defineTool({
      name: 'stop',
      description: 'Cancels the run',
      input: z.object({}),
      execute: (_args, { abortSignal }) => {
        received = abortSignal;
        controller.abort();
        return 'stopping';
      },
    });
    const childModel = mockModel([{ toolCalls: [{ name: 'stop' }] }, 'never']);
    const researcher = createAgent({ provider: childModel, tools: [stop], description: 'Researches' });

    const result = await run({
      provider: mockModel([{ toolCalls: [task('researcher')] }, 'never']),
      subagents: { researcher },
      signal: controller.signal,
    });

    expect(received).toBe(controller.signal);
    expect(childModel.calls).toHaveLength(1);
    expect(result.finishReason).toBe('aborted');
  });

  it("forwards the child's events to the parent's onAgentEvent, tagged with the parent tool call", async () => {
    const events: AgentEvent[] = [];
    const researcher = createAgent({
      name: 'researcher',
      provider: mockModel([{ toolCalls: [{ name: 'lookup' }] }, 'found']),
      tools: [lookupTool()],
      description: 'Researches',
    });

    await run({
      provider: mockModel([{ toolCalls: [task('researcher')] }, 'done']),
      subagents: { researcher },
      onAgentEvent: (event) => events.push(event),
    });

    const forwarded = events.filter((e) => e.subagent);
    // The child's run.start / run.done are internal: they never reach the
    // lead's listeners, so `seq` stays contiguous across them.
    expect(forwarded.some((e) => e.type === 'run.start' || e.type === 'run.done')).toBe(false);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(forwarded.map((e) => e.type)).toEqual([
      'step.start',
      'tool.start',
      'tool.done',
      'step.done',
      'step.start',
      'text.delta',
      'text.done',
      'step.done',
    ]);
    expect(forwarded[1]).toMatchObject({ type: 'tool.start', toolName: 'lookup' });
    expect(forwarded[0].subagent).toEqual({
      name: 'researcher',
      depth: 1,
      toolCallId: 'researcher-call',
      description: 'researcher task',
    });
    expect(events.filter((e) => !e.subagent && e.type === 'run.start')).toHaveLength(1);
    expect(events.filter((e) => !e.subagent && e.type === 'run.done')).toHaveLength(1);
  });

  it('tags events of a sub-agent of a sub-agent with the whole chain', async () => {
    const events: AgentEvent[] = [];
    const helper = createAgent({ name: 'helper', provider: mockModel(['helped']), description: 'Helps' });
    const researcher = createAgent({
      provider: mockModel([{ toolCalls: [task('helper')] }, 'researched']),
      description: 'Researches',
      subagents: { helper },
    });

    await run({
      provider: mockModel([{ toolCalls: [task('researcher')] }, 'done']),
      subagents: { researcher },
      maxSubagentDepth: 2,
      onAgentEvent: (event) => events.push(event),
    });

    const helperEvent = events.find((e) => e.subagent?.name === 'helper');
    expect(helperEvent?.subagent).toEqual({
      name: 'helper',
      depth: 2,
      toolCallId: 'helper-call',
      description: 'helper task',
      parent: { name: 'researcher', depth: 1, toolCallId: 'researcher-call', description: 'researcher task' },
    });
  });

  it("inherits toolConcurrency unless the child sets its own", async () => {
    async function maxConcurrentChildCalls(childConcurrency?: number) {
      let active = 0;
      let max = 0;
      const slow = defineTool({
        name: 'slow',
        description: 'Takes a moment',
        input: z.object({}),
        execute: async () => {
          active++;
          max = Math.max(max, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          return 'ok';
        },
      });
      const researcher = createAgent({
        provider: mockModel([{ toolCalls: [{ name: 'slow' }, { name: 'slow' }] }, 'found']),
        tools: [slow],
        description: 'Researches',
        toolConcurrency: childConcurrency,
      });
      await run({ provider: mockModel([{ toolCalls: [task('researcher')] }, 'done']), subagents: { researcher }, toolConcurrency: 1 });
      return max;
    }

    expect(await maxConcurrentChildCalls()).toBe(1);
    expect(await maxConcurrentChildCalls(2)).toBe(2);
  });

});

describe('approval inside a sub-agent (LOU-Y1)', () => {
  it('pauses the whole run on the child call, and resume runs it exactly once and finishes both runs', async () => {
    const approvals = memoryApprovals();
    const { agent: researcher, model: childModel, sent } = approvingChild('researcher', [
      { toolCalls: [{ name: 'send', args: { to: 'ana' } }] },
      'sent!',
    ]);
    const leadModel = mockModel([{ toolCalls: [task('researcher')] }, 'done']);
    const subagents = { researcher };

    const paused = await run({ provider: leadModel, subagents, approvalStore: approvals.store });

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(sent).toEqual([]);
    const { pending } = approvals.only();
    expect(pending).toMatchObject({ id: paused.approvalId, toolName: 'send', args: { to: 'ana' }, subagentPath: ['researcher'] });

    const result = await resumeAfterApproval({ id: pending.id, approved: true }, approvals.store, new ToolRegistry(), leadModel, {
      subagents,
    });

    expect(sent).toEqual(['ana']);
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('done');
    // Child usage before the pause (kept in the snapshot) and after the resume both roll up.
    expect(result.usage.delegated?.runs).toBe(2);
    expect(result.usage.modelCalls).toBe(4);
    expect(approvals.records.size).toBe(0);
    // The child resumed with its own transcript; the parent got the child's final answer as the task result.
    expect(toolResults(childModel.calls[1].messages as Message[])[0].content).toContain('sent to ana');
    const taskResults = toolResults(result.messages);
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0].content).toContain("sent!\\n\\n[sub-agent 'researcher': 2 step(s)");
    expect(JSON.stringify(result.messages)).not.toContain('awaiting-approval');
  });

  it('a streaming lead reports the child call in one top-level approval.requested', async () => {
    const approvals = memoryApprovals();
    const { agent: researcher } = approvingChild('researcher', [{ toolCalls: [{ name: 'send', args: { to: 'ana' } }] }]);

    const run = AgentExecutor.stream({
      agent: lead,
      input: 'go',
      provider: mockModel([{ toolCalls: [task('researcher')] }]),
      subagents: { researcher },
      approvalStore: approvals.store,
    });
    const events = [];
    for await (const event of run) events.push(event);

    const requested = events.filter((e) => e.type === 'approval.requested');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ approvalId: (await run.result).approvalId, toolName: 'send', args: { to: 'ana' } });
    expect(requested[0].subagent).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'awaiting-approval' });
  });

  it('a rejection reaches the child, which carries on without running the call', async () => {
    const approvals = memoryApprovals();
    const { agent: researcher, model: childModel, sent } = approvingChild('researcher', [
      { toolCalls: [{ name: 'send', args: { to: 'ana' } }] },
      'could not send',
    ]);
    const leadModel = mockModel([{ toolCalls: [task('researcher')] }, 'done']);

    const paused = await run({ provider: leadModel, subagents: { researcher }, approvalStore: approvals.store });
    const result = await resumeAfterApproval(
      { id: paused.approvalId!, approved: false, note: 'no' },
      approvals.store,
      new ToolRegistry(),
      leadModel,
      { subagents: { researcher } }
    );

    expect(sent).toEqual([]);
    expect(toolResults(childModel.calls[1].messages as Message[])[0].content).toContain('rejected by the reviewer');
    expect(toolResults(result.messages)[0].content).toContain('could not send');
  });

  it('pauses again when the resumed child needs another approval', async () => {
    const approvals = memoryApprovals();
    const { agent: researcher, sent } = approvingChild('researcher', [
      { toolCalls: [{ name: 'send', args: { to: 'ana' } }] },
      { toolCalls: [{ name: 'send', args: { to: 'bo' } }] },
      'both sent',
    ]);
    const leadModel = mockModel([{ toolCalls: [task('researcher')] }, 'done']);
    const options = { subagents: { researcher } };

    const first = await run({ provider: leadModel, ...options, approvalStore: approvals.store });
    const second = await resumeAfterApproval({ id: first.approvalId!, approved: true }, approvals.store, new ToolRegistry(), leadModel, options);

    expect(second.finishReason).toBe('awaiting-approval');
    expect(sent).toEqual(['ana']);
    expect(approvals.only().pending).toMatchObject({ id: second.approvalId, args: { to: 'bo' } });

    const done = await resumeAfterApproval({ id: second.approvalId!, approved: true }, approvals.store, new ToolRegistry(), leadModel, options);

    expect(sent).toEqual(['ana', 'bo']);
    expect(done.text).toBe('done');
    expect(toolResults(done.messages)[0].content).toContain('both sent');
  });

  it('resumes a sub-agent of a sub-agent', async () => {
    const approvals = memoryApprovals();
    const { agent: helper, sent } = approvingChild('helper', [{ toolCalls: [{ name: 'send', args: { to: 'ana' } }] }, 'helper sent']);
    const researcher = createAgent({
      provider: mockModel([{ toolCalls: [task('helper')] }, 'researcher done']),
      description: 'Researches',
      subagents: { helper },
    });
    const leadModel = mockModel([{ toolCalls: [task('researcher')] }, 'done']);
    const options = { subagents: { researcher }, maxSubagentDepth: 2 };

    const paused = await run({ provider: leadModel, ...options, approvalStore: approvals.store });
    expect(approvals.only().pending.subagentPath).toEqual(['researcher', 'helper']);

    const result = await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvals.store, new ToolRegistry(), leadModel, options);

    expect(sent).toEqual(['ana']);
    expect(result.text).toBe('done');
    expect(toolResults(result.messages)[0].content).toContain('researcher done');
  });

  it('keeps the results of sibling tool calls that finished in the same turn, without re-running them', async () => {
    const approvals = memoryApprovals();
    const { agent: researcher } = approvingChild('researcher', [{ toolCalls: [{ name: 'send', args: { to: 'ana' } }] }, 'sent']);
    const writerModel = mockModel(['draft ready']);
    const writer = createAgent({ provider: writerModel, description: 'Writes' });
    const leadModel = mockModel([{ toolCalls: [task('researcher'), task('writer')] }, 'done']);
    const options = { subagents: { researcher, writer } };

    const paused = await run({ provider: leadModel, ...options, approvalStore: approvals.store });
    const result = await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvals.store, new ToolRegistry(), leadModel, options);

    expect(writerModel.calls).toHaveLength(1);
    const results = toolResults(result.messages);
    expect(results.map((m) => m.toolCallId)).toEqual(['researcher-call', 'writer-call']);
    expect(results[0].content).toContain('sent');
    expect(results[1].content).toContain('draft ready');
  });

  it('when two sub-agents pause in one turn, pauses on the first and tells the model the second did not run', async () => {
    const approvals = memoryApprovals();
    const first = approvingChild('first', [{ toolCalls: [{ name: 'send', args: { to: 'ana' } }] }, 'first sent']);
    const second = approvingChild('second', [{ toolCalls: [{ name: 'send', args: { to: 'bo' } }] }, 'second sent']);
    const leadModel = mockModel([{ toolCalls: [task('first'), task('second')] }, 'done']);
    const options = { subagents: { first: first.agent, second: second.agent } };

    const paused = await run({ provider: leadModel, ...options, approvalStore: approvals.store });

    expect(approvals.only().pending.subagentPath).toEqual(['first']);
    const secondResult = toolResults(paused.messages)[1];
    expect(secondResult.isError).toBe(true);
    expect(secondResult.content).toContain("Sub-agent 'second' needed approval to run 'send'");
    expect(JSON.parse(secondResult.content as string)).toMatchObject({ error: 'ToolNotRunError', kind: 'not-run', toolName: 'task' });

    await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvals.store, new ToolRegistry(), leadModel, options);

    expect(first.sent).toEqual(['ana']);
    expect(second.sent).toEqual([]);
  });

  it('without an approval store, the child call becomes an error result and nothing runs', async () => {
    const { agent: researcher, sent } = approvingChild('researcher', [{ toolCalls: [{ name: 'send', args: { to: 'ana' } }] }]);

    const result = await run({ provider: mockModel([{ toolCalls: [task('researcher')] }, 'done']), subagents: { researcher } });

    expect(sent).toEqual([]);
    const [taskResult] = toolResults(result.messages);
    expect(taskResult.isError).toBe(true);
    expect(taskResult.content).toContain('requires approval but no approvalStore');
  });
});

describe('durable sessions with sub-agents (LOU-U7/U8 with LOU-Y1)', () => {
  function checkpoints() {
    const data = new Map<string, string>();
    const store = new KVCheckpointStore({
      get: async (key) => data.get(key) ?? null,
      put: async (key, value) => {
        data.set(key, value);
      },
      delete: async (key) => {
        data.delete(key);
      },
    });
    return store;
  }

  it('a run paused on a sub-agent marks its session awaiting approval until resumed', async () => {
    const approvals = memoryApprovals();
    const checkpointStore = checkpoints();
    const { agent: researcher, sent } = approvingChild('researcher', [{ toolCalls: [{ name: 'send', args: { to: 'ana' } }] }, 'sent']);
    const leadModel = mockModel([{ toolCalls: [task('researcher')] }, 'done', 'next answer']);
    const options = { subagents: { researcher } };
    const session = { sessionId: 's-1', checkpointStore };

    const paused = await run({ provider: leadModel, ...options, ...session, approvalStore: approvals.store });

    expect(await checkpointStore.load('s-1')).toMatchObject({ status: 'awaiting-approval', approvalId: paused.approvalId });
    await expect(run({ provider: leadModel, ...options, ...session, input: 'hello?' })).rejects.toBeInstanceOf(
      SessionAwaitingApprovalError
    );

    const done = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvals.store,
      new ToolRegistry(),
      leadModel,
      options,
      checkpointStore
    );

    expect(sent).toEqual(['ana']);
    expect(done.text).toBe('done');
    expect(await checkpointStore.load('s-1')).toMatchObject({ status: 'finished' });
    const next = await run({ provider: leadModel, ...options, ...session, input: 'and now?' });
    expect(next.text).toBe('next answer');
  });

  it('keeps the session awaiting approval when the resumed sub-agent pauses again', async () => {
    const approvals = memoryApprovals();
    const checkpointStore = checkpoints();
    const { agent: researcher, sent } = approvingChild('researcher', [
      { toolCalls: [{ name: 'send', args: { to: 'ana' } }] },
      { toolCalls: [{ name: 'send', args: { to: 'bo' } }] },
      'both sent',
    ]);
    const leadModel = mockModel([{ toolCalls: [task('researcher')] }, 'done']);
    const options = { subagents: { researcher } };
    const session = { sessionId: 's-2', checkpointStore };

    const first = await run({ provider: leadModel, ...options, ...session, approvalStore: approvals.store });
    const resume = (id: string) =>
      resumeAfterApproval({ id, approved: true }, approvals.store, new ToolRegistry(), leadModel, options, checkpointStore);
    const second = await resume(first.approvalId!);

    expect(second.finishReason).toBe('awaiting-approval');
    expect(await checkpointStore.load('s-2')).toMatchObject({ status: 'awaiting-approval', approvalId: second.approvalId });
    await expect(run({ provider: leadModel, ...options, ...session })).rejects.toBeInstanceOf(SessionAwaitingApprovalError);

    const done = await resume(second.approvalId!);

    expect(sent).toEqual(['ana', 'bo']);
    expect(done.text).toBe('done');
    expect(await checkpointStore.load('s-2')).toMatchObject({ status: 'finished' });
  });

  it('a task call of a step paused on an approval runs at once; its sub-agent pause follows the decision (Eve TOOLS-F12)', async () => {
    const approvals = memoryApprovals();
    const confirmed: string[] = [];
    const confirm = defineTool({
      name: 'confirm',
      description: 'Confirms',
      input: z.object({}),
      needsApproval: true,
      execute: (_args, ctx) => {
        confirmed.push(ctx.toolCallId);
        return 'confirmed';
      },
    });
    const registry = new ToolRegistry();
    registry.registerMany([confirm]);
    const { agent: researcher, model: childModel, sent } = approvingChild('researcher', [
      { toolCalls: [{ name: 'send', args: { to: 'ana' } }] },
      'sent',
    ]);
    const leadModel = mockModel([{ toolCalls: [{ name: 'confirm', id: 'confirm-call' }, task('researcher')] }, 'done']);
    const options = { subagents: { researcher } };
    const agent = { ...lead, tools: { confirm: { tool: 'confirm' } } };

    const first = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: leadModel,
      toolRegistry: registry,
      ...options,
      approvalStore: approvals.store,
    });
    expect(approvals.only().snapshot.remainingToolCalls).toEqual([]);
    expect(approvals.only().snapshot.heldSubagent).toMatchObject({ toolCallId: 'researcher-call', agentName: 'researcher' });
    expect(childModel.calls).toHaveLength(1);
    expect(sent).toEqual([]);

    const second = await resumeAfterApproval({ id: first.approvalId!, approved: true }, approvals.store, registry, leadModel, options);

    expect(confirmed).toEqual(['confirm-call']);
    expect(second.finishReason).toBe('awaiting-approval');
    expect(approvals.only().pending).toMatchObject({ toolName: 'send', subagentPath: ['researcher'] });

    const done = await resumeAfterApproval({ id: second.approvalId!, approved: true }, approvals.store, registry, leadModel, options);

    expect(sent).toEqual(['ana']);
    expect(done.text).toBe('done');
    expect(leadModel.calls).toHaveLength(2);
    expect(toolResults(done.messages).map((m) => m.toolCallId)).toEqual(['confirm-call', 'researcher-call']);
    expect(toolResults(done.messages)[1].content).toContain('sent');
  });
});
