import { describe, it, expect } from 'vitest';
import { AgentExecutor } from './AgentExecutor';
import { resumeAfterApproval } from './resume';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import { executeToolWithSandboxGuard } from './sandboxGuard';
import { buildToolRunContext } from './toolRunContext';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';
import { type ToolExecutionContext } from '../types';
import type { SandboxAdapter } from '../security/sandboxCore';
import { NoopSandbox } from '../security/sandboxCore';
import { mockModel } from '../testing';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { z } from 'zod';

/** What a tool saw as its execute context. */
interface Seen {
  ctx: ToolExecutionContext;
}

function inMemoryApprovalStore(): ApprovalStore {
  const records = new Map<string, { pending: PendingApproval; snapshot: ExecutionSnapshot }>();
  return {
    async save(pending, snapshot) {
      records.set(pending.id, { pending, snapshot });
    },
    async resolve(id) {
      const record = records.get(id) ?? null;
      records.delete(id);
      return record;
    },
  };
}

const sandbox: SandboxAdapter = {
  name: 'fake',
  run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  writeFile: async () => undefined,
};

function register(registry: ToolRegistry, seen: Partial<Seen>, flags: { sandboxed: boolean; approval: boolean }) {
  const record = (ctx: ToolExecutionContext) => {
    seen.ctx = ctx;
    return { ok: true };
  };
  registry.register('probe', {
    displayName: 'Probe',
    tool: { description: 'probe', parameters: {}, execute: async (_a: unknown, ctx: ToolExecutionContext) => record(ctx) } as never,
    needsApproval: flags.approval,
    ...(flags.sandboxed && {
      requiresSandbox: true,
      // Records the third argument, as a tool author would read it.
      sandboxExecute: async (_args: unknown, sb: SandboxAdapter, ctx?: ToolExecutionContext) => {
        expect(sb).toBe(sandbox);
        return record(ctx as ToolExecutionContext);
      },
    }),
  });
}

function agentFor() {
  return AgentBuilder.create()
    .setName('Probe Agent')
    .addTool('probe', { tool: 'probe', options: {} })
    .build();
}

const callScript = () => mockModel([{ toolCalls: [{ id: 'call-42', name: 'probe' }] }, 'done']);

/** Each path runs the `probe` tool once, under the given run signal. */
type Path = (seen: Partial<Seen>, controller: AbortController) => Promise<void>;

async function runMainLoop(seen: Partial<Seen>, controller: AbortController, sandboxed: boolean) {
  const registry = new ToolRegistry();
  register(registry, seen, { sandboxed, approval: false });
  await AgentExecutor.execute({
    agent: agentFor(),
    input: 'hello probe',
    provider: callScript(),
    toolRegistry: registry,
    sandbox,
    signal: controller.signal,
  });
}

async function runResume(seen: Partial<Seen>, controller: AbortController, sandboxed: boolean) {
  const registry = new ToolRegistry();
  register(registry, seen, { sandboxed, approval: true });
  const approvalStore = inMemoryApprovalStore();
  const paused = await AgentExecutor.execute({
    agent: agentFor(),
    input: 'hello probe',
    provider: callScript(),
    toolRegistry: registry,
    approvalStore,
    sandbox,
  });
  await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, registry, mockModel(['done']), {
    sandbox,
    signal: controller.signal,
  });
}

const paths: Array<[string, Path]> = [
  ['main loop', (seen, controller) => runMainLoop(seen, controller, false)],
  ['main loop, sandbox path', (seen, controller) => runMainLoop(seen, controller, true)],
  ['resume after approval', (seen, controller) => runResume(seen, controller, false)],
  ['resume after approval, sandbox path', (seen, controller) => runResume(seen, controller, true)],
];

describe('tool execute context (LOU-U15)', () => {
  it.each(paths)('%s hands the tool a real toolCallId, messages and abortSignal', async (_name, run) => {
    const seen: Partial<Seen> = {};
    const controller = new AbortController();
    await run(seen, controller);

    const ctx = seen.ctx!;
    expect(ctx.toolCallId).toBe('call-42');
    expect(ctx.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'hello probe' })]));
    expect(ctx.abortSignal).toBe(controller.signal);
    expect(ctx.abortSignal?.aborted).toBe(false);
    controller.abort();
    expect(ctx.abortSignal?.aborted).toBe(true);
  });

  it('the messages are the transcript before the call, as a read-only copy', async () => {
    const seen: Partial<Seen> = {};
    await runMainLoop(seen, new AbortController(), false);
    const messages = seen.ctx!.messages as unknown as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['user']);
    expect(Object.isFrozen(messages)).toBe(true);
    expect(() => messages.push({ role: 'user' })).toThrow();
  });

  it('sandboxExecute implementations that take only (args, sandbox) keep working', async () => {
    const result = await executeToolWithSandboxGuard(
      'legacy',
      {
        displayName: 'Legacy',
        tool: { description: 'x', parameters: {} } as never,
        requiresSandbox: true,
        sandboxExecute: async (args: unknown, sb: SandboxAdapter) => ({ args, sb: sb.name }),
      },
      { a: 1 },
      NoopSandbox
    );
    expect(result).toEqual({ args: { a: 1 }, sb: NoopSandbox.name });
  });

  it('a call made outside a model turn (flow tool node) still gets an id, empty messages and the signal', async () => {
    const seen: Partial<Seen> = {};
    const registry = new ToolRegistry();
    register(registry, seen, { sandboxed: true, approval: false });
    const controller = new AbortController();
    await executeToolWithSandboxGuard('probe', registry.get('probe')!, {}, sandbox, controller.signal);
    expect(seen.ctx!.toolCallId).toEqual(expect.any(String));
    expect(seen.ctx!.messages).toEqual([]);
    expect(seen.ctx!.abortSignal).toBe(controller.signal);
  });

  it('buildToolRunContext drops the system prompt and the assistant turn that made the call', () => {
    const ctx = buildToolRunContext({
      toolCallId: 'c1',
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{}' } }] },
        { role: 'tool', content: '1', toolCallId: 'other' },
      ],
    });
    expect(ctx.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('the tool execute context carries the run session (LOU-D23.2)', () => {
  const sessionProbe = (seen: string[]) =>
    defineTool({
      name: 'where',
      description: 'Reports its session',
      input: z.object({}),
      execute: (_args, ctx) => {
        seen.push(ctx.sessionId ?? 'none');
        return 'ok';
      },
    });
  const callWhere = () => mockModel([{ toolCalls: [{ id: 'c1', name: 'where' }] }, 'done']);

  it('main loop and resume after approval: the run sessionId; none without one', async () => {
    const seen: Partial<Seen> = {};
    const registry = new ToolRegistry();
    register(registry, seen, { sandboxed: false, approval: false });
    await AgentExecutor.execute({ agent: agentFor(), input: 'hi', provider: callScript(), toolRegistry: registry, sessionId: 's-1' });
    expect(seen.ctx!.sessionId).toBe('s-1');

    await AgentExecutor.execute({ agent: agentFor(), input: 'hi', provider: callScript(), toolRegistry: registry });
    expect(seen.ctx!.sessionId).toBeUndefined();

    const approvals = new ToolRegistry();
    register(approvals, seen, { sandboxed: false, approval: true });
    const approvalStore = inMemoryApprovalStore();
    const paused = await AgentExecutor.execute({ agent: agentFor(), input: 'hi', provider: callScript(), toolRegistry: approvals, approvalStore, sessionId: 's-2' });
    await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, approvals, mockModel(['done']), {});
    expect(seen.ctx!.sessionId).toBe('s-2');
  });

  it("createAgent: a session's id, and a sub-agent's own id under it", async () => {
    const seen: string[] = [];
    const agent = createAgent({ provider: callWhere(), tools: [sessionProbe(seen)] });
    await agent.session({ id: 'chat-1' }).send('where?');

    const child = createAgent({ provider: callWhere(), tools: [sessionProbe(seen)], description: 'Finds out' });
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [{ id: 't1', name: 'task', args: { agent: 'child', prompt: 'where?', description: 'where' } }] }, 'done']),
      subagents: { child },
    });
    await lead.session({ id: 'chat-2' }).send('delegate');
    expect(seen).toEqual(['chat-1', 'chat-2/t1']);
  });
});
