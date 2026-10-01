/**
 * LOU-U14: every tool failure path hands the model the same
 * `{ error, toolName, message, kind }` result, flagged `isError`.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AgentExecutor, ExecutionEvent } from './AgentExecutor';
import { InMemoryApprovalStore } from './InMemoryApprovalStore';
import type { ApprovalStore } from './ApprovalGate';
import { HookRegistry } from './hooks';
import { resumeAfterApproval } from './resume';
import { toolErrorResult, type ToolErrorKind } from './toolErrors';
import { defineTool, DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { loadMcpTools } from '../tools/mcp/McpToolLoader';
import { mockModel, MockTurn } from '../testing';
import { AgentConfig } from '../types';
import type { Message } from '../providers';

const input = z.object({ n: z.number() });

function simpleTool(name: string, extra: Partial<Parameters<typeof defineTool>[0]> = {}): DefinedTool {
  return defineTool({
    name,
    description: name,
    input,
    execute: async () => 'ok',
    ...extra,
  } as Parameters<typeof defineTool>[0]);
}

function agentFor(names: string[]): AgentConfig {
  const tools: AgentConfig['tools'] = {};
  for (const name of names) tools[name] = { tool: name };
  return { id: 'agent-1', name: 'Agent', prompt: 'p', tools };
}

function registryOf(tools: DefinedTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerMany(tools);
  return registry;
}

const call = (name: string, args: Record<string, unknown> = { n: 1 }): MockTurn => ({
  toolCalls: [{ name, args, id: `call_${name}` }],
});

/** The one `tool` message the model sees on its second turn, plus what observers saw. */
interface Observed {
  message: Message;
  payload: Record<string, unknown>;
  hookError?: string;
  /** The `tool-result` event's outcome: `tool.error` events are derived from it. */
  eventOutcome?: { error?: string; result?: { error?: string } };
}

async function runMainLoop(
  registry: ToolRegistry | undefined,
  toolName: string,
  args?: Record<string, unknown>
): Promise<Observed> {
  const model = mockModel([call(toolName, args), 'done']);
  const postToolCall = vi.fn();
  const hooks = new HookRegistry();
  hooks.register({ name: 'spy', postToolCall });
  const events: ExecutionEvent[] = [];
  await AgentExecutor.execute({
    agent: agentFor([toolName]),
    input: 'go',
    provider: model,
    toolRegistry: registry,
    hooks,
    onEvent: (e) => events.push(e),
  });
  const message = (model.calls[1].messages as Message[]).find((m) => m.role === 'tool')!;
  const resultEvent = events.find((e) => e.type === 'tool-result') as { toolResult?: Observed['eventOutcome'] } | undefined;
  return {
    message,
    payload: JSON.parse(message.content as string) as Record<string, unknown>,
    hookError: postToolCall.mock.calls[0]?.[1]?.error,
    eventOutcome: resultEvent?.toolResult,
  };
}

/** Pauses a run on `approve_me`, lets `tamper` adjust the store, then resumes with `decision`. */
async function runResume(options: {
  tools: DefinedTool[];
  calls?: string[];
  approved: boolean;
  resumeTools?: DefinedTool[];
  dropRemaining?: boolean;
  /** A snapshot saved before LOU-W9.2: no agent fingerprint. */
  legacySnapshot?: boolean;
}): Promise<Message[]> {
  const inner = new InMemoryApprovalStore();
  const approvalStore: ApprovalStore = {
    save: async (pending, snapshot) => {
      if (options.dropRemaining) delete snapshot.remainingToolCalls;
      if (options.legacySnapshot) delete snapshot.agentFingerprint;
      await inner.save(pending, snapshot);
    },
    resolve: (id) => inner.resolve(id),
  };
  const names = options.calls ?? ['approve_me'];
  const paused = await AgentExecutor.execute({
    agent: agentFor(options.tools.map((t) => t.name)),
    input: 'go',
    provider: mockModel([{ toolCalls: names.map((name) => ({ name, args: { n: 1 }, id: `call_${name}` })) }]),
    toolRegistry: registryOf(options.tools),
    approvalStore,
  });
  expect(paused.finishReason).toBe('awaiting-approval');
  const resumed = await resumeAfterApproval(
    { id: paused.approvalId!, approved: options.approved, note: 'nope' },
    approvalStore,
    registryOf(options.resumeTools ?? options.tools),
    mockModel(['done'])
  );
  return resumed.messages.filter((m) => m.role === 'tool');
}

const approveMe = (extra: Partial<Parameters<typeof defineTool>[0]> = {}) =>
  simpleTool('approve_me', { needsApproval: true, ...extra });

const boom = () =>
  simpleTool('boom', {
    execute: async () => {
      throw new TypeError('bad input');
    },
  } as never);

const noSandbox = (extra: Partial<Parameters<typeof defineTool>[0]> = {}) =>
  simpleTool('risky', { requiresSandbox: true, ...extra });

function fakeMcpClient(): Client {
  return {
    listTools: async () => ({ tools: [{ name: 'do_it', description: 'Do it', inputSchema: { type: 'object' } }] }),
    callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'rate limited' }] }),
  } as unknown as Client;
}

interface Row {
  path: string;
  kind: ToolErrorKind;
  error: string;
  message: string | RegExp;
  run: () => Promise<{ message: Message; payload: Record<string, unknown>; observed?: Observed }>;
}

const viaMain = (run: () => Promise<Observed>): Row['run'] =>
  async () => {
    const observed = await run();
    return { message: observed.message, payload: observed.payload, observed };
  };

const viaResume = (run: () => Promise<Message[]>, pick = 0): Row['run'] =>
  async () => {
    const message = (await run())[pick];
    return { message, payload: JSON.parse(message.content as string) as Record<string, unknown> };
  };

const rows: Row[] = [
  {
    path: 'thrown error (main loop)',
    kind: 'execution',
    error: 'TypeError',
    message: 'bad input',
    run: viaMain(() => runMainLoop(registryOf([boom()]), 'boom')),
  },
  {
    path: 'validation failure (main loop)',
    kind: 'validation',
    error: 'ToolArgumentsValidationError',
    message: /Invalid arguments for tool 'strict'/,
    run: viaMain(() => runMainLoop(registryOf([simpleTool('strict')]), 'strict', { n: 'x' })),
  },
  {
    path: 'tool not found (main loop)',
    kind: 'not-found',
    error: 'ToolNotFoundError',
    message: "Tool 'ghost' not found",
    run: viaMain(() => runMainLoop(registryOf([]), 'ghost')),
  },
  {
    path: 'no registry (main loop)',
    kind: 'not-found',
    error: 'ToolNotFoundError',
    message: 'No tool registry available',
    run: viaMain(() => runMainLoop(undefined, 'ghost')),
  },
  {
    path: 'sandbox fail-closed (main loop)',
    kind: 'sandbox',
    error: 'SandboxRequiredError',
    message: /requiresSandbox but does not implement sandboxExecute/,
    run: viaMain(() => runMainLoop(registryOf([noSandbox()]), 'risky')),
  },
  {
    path: 'MCP isError result (main loop)',
    kind: 'mcp',
    error: 'McpToolError',
    message: 'rate limited',
    run: viaMain(async () => {
      const registry = new ToolRegistry();
      registry.registerMany(await loadMcpTools(fakeMcpClient(), 'srv', { approval: 'never' }));
      return runMainLoop(registry, 'srv__do_it', {});
    }),
  },
  {
    path: 'rejected approval (resume)',
    kind: 'rejected',
    error: 'ToolRejectedError',
    message: 'Tool execution was rejected by the reviewer',
    run: viaResume(() => runResume({ tools: [approveMe()], approved: false })),
  },
  {
    path: 'remaining calls "not run" (resume, old snapshot)',
    kind: 'not-run',
    error: 'ToolNotRunError',
    message: /Tool call was not run/,
    run: viaResume(
      () =>
        runResume({
          tools: [approveMe(), simpleTool('later')],
          calls: ['approve_me', 'later'],
          approved: true,
          dropRemaining: true,
        }),
      1
    ),
  },
  {
    path: 'tool not found (resume of a snapshot without an agent fingerprint)',
    kind: 'not-found',
    error: 'ToolNotFoundError',
    message: "Tool 'approve_me' not found in registry",
    run: viaResume(() => runResume({ tools: [approveMe()], resumeTools: [], approved: true, legacySnapshot: true })),
  },
  {
    path: 'thrown error after approval (resume)',
    kind: 'execution',
    error: 'TypeError',
    message: 'bad input',
    run: viaResume(() =>
      runResume({
        tools: [
          approveMe({
            execute: async () => {
              throw new TypeError('bad input');
            },
          } as never),
        ],
        approved: true,
      })
    ),
  },
  {
    path: 'sandbox fail-closed after approval (resume)',
    kind: 'sandbox',
    error: 'SandboxRequiredError',
    message: /requiresSandbox but does not implement sandboxExecute/,
    run: viaResume(() => runResume({ tools: [approveMe({ requiresSandbox: true })], approved: true })),
  },
];

describe('one tool-error shape on every failure path (LOU-U14)', () => {
  it.each(rows)('$path -> kind $kind', async (row) => {
    const { message, payload, observed } = await row.run();

    expect(message.isError).toBe(true);
    expect(payload).toMatchObject({ error: row.error, kind: row.kind });
    expect(typeof payload.toolName).toBe('string');
    expect(payload.message).toEqual(typeof row.message === 'string' ? row.message : expect.stringMatching(row.message));
    expect(message.toolName).toBe(payload.toolName);
    // Only the shared fields (plus per-kind extras) are present: no stack, no raw error.
    expect(Object.keys(payload)).not.toContain('stack');

    if (observed) {
      // Hooks and events (which `tool.error` is derived from) agree that the call failed.
      expect(observed.hookError).toBe(payload.message);
      expect(observed.eventOutcome?.error).toBe(payload.message);
      expect(observed.eventOutcome?.result?.error).toBe(row.error);
    }
  });

  it('keeps the per-kind extras next to the shared fields', async () => {
    const rejected = await viaResume(() => runResume({ tools: [approveMe()], approved: false }))();
    expect(rejected.payload).toEqual({
      error: 'ToolRejectedError',
      toolName: 'approve_me',
      message: 'Tool execution was rejected by the reviewer',
      kind: 'rejected',
      note: 'nope',
    });

    const model = mockModel([call('strict', { n: 'x' }), 'done']);
    await AgentExecutor.execute({
      agent: agentFor(['strict']),
      input: 'go',
      provider: model,
      toolRegistry: registryOf([simpleTool('strict')]),
    });
    const message = (model.calls[1].messages as Message[]).find((m) => m.role === 'tool')!;
    expect(JSON.parse(message.content as string)).toEqual({
      error: 'ToolArgumentsValidationError',
      toolName: 'strict',
      message: expect.stringContaining("Invalid arguments for tool 'strict'"),
      kind: 'validation',
      issues: [{ path: 'n', message: expect.any(String) }],
    });
  });
});

describe('toolErrorResult()', () => {
  it('caps every message at 2,000 characters', () => {
    const result = toolErrorResult({ toolName: 't', error: 'x'.repeat(5000), kind: 'not-run' });
    expect(result.message).toBe(`${'x'.repeat(2000)}... (truncated)`);
  });

  it('takes the name and message of an Error and defaults the kind to execution', () => {
    expect(toolErrorResult({ toolName: 't', error: new RangeError('too big') })).toEqual({
      error: 'RangeError',
      toolName: 't',
      message: 'too big',
      kind: 'execution',
    });
  });

  it('uses the kind an error declares, and a plain name for a plain message', () => {
    const declared = Object.assign(new Error('x'), { toolErrorKind: 'mcp' });
    expect(toolErrorResult({ toolName: 't', error: declared }).kind).toBe('mcp');
    expect(toolErrorResult({ toolName: 't', error: 'gone', kind: 'not-found' }).error).toBe('ToolNotFoundError');
    expect(toolErrorResult({ toolName: 't', error: 42 }).message).toBe('42');
  });

  it('adds the call id and details without letting details override the shared fields', () => {
    const result = toolErrorResult({
      toolName: 't',
      toolCallId: 'call_1',
      error: 'no',
      kind: 'rejected',
      details: { note: 'why', message: 'spoofed', kind: 'mcp' },
    });
    expect(result).toEqual({
      error: 'ToolRejectedError',
      toolName: 't',
      message: 'no',
      kind: 'rejected',
      toolCallId: 'call_1',
      note: 'why',
    });
  });
});
