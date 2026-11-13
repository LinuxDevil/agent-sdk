import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testToolContext } from '@linuxdevil/lousho/testing';
import type { ToolDescriptor } from '@linuxdevil/lousho';
import { condenseTrace, TRACE_STEP_LIMIT, type GetTraceOutput } from '../condenseTrace';
import { agentTraceDir } from '../../../traceStore';
import { AgentRepo } from '../../../storage/agentRepo';
import { buildAuthorTools, type AuthorToolDeps, type CatalogService } from '../index';
import type { AuthorTurn } from '../../turnRunner';
import type { WorkspaceContext } from '../../../workspace/context';
import { AuthorSessionStore } from '../../sessionStore';
import { passReview } from '../../proposal/review';
import type { AuthorToolFailure } from '../../../../shared/authorWire';
import type { SpanEvent } from '../../../../shared/wireTypes';

/**
 * `condenseTrace` (AA20): a trace file's GenAI spans condensed to the
 * short step list `getTrace` returns - model/tool/sub-agent/handoff/
 * guardrail steps in start order, cost summed off the chat spans, one
 * error row per failed span, 60 steps max plus a "+N more steps" tail.
 * Covers the getTrace tool itself too: the fixture's spans written as a
 * real `.jsonl` trace file under a temp workspace, id validation and the
 * every-agent search.
 */

const FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, '__fixtures__', 'trace-basic.json'), 'utf8')
) as SpanEvent[];

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function span(over: Partial<SpanEvent>): SpanEvent {
  return {
    id: `s-${Math.random().toString(36).slice(2)}`,
    name: 'span',
    startTime: 0,
    attributes: {},
    ...over,
  };
}

/** `n` ended `execute_tool` child spans under one root, start times ascending. */
function toolSpans(n: number): SpanEvent[] {
  const spans: SpanEvent[] = [
    span({
      id: 'root',
      name: 'invoke_agent a',
      startTime: 0,
      endTime: n + 1,
      attributes: { 'gen_ai.operation.name': 'invoke_agent' },
      status: { code: 'ok' },
    }),
  ];
  for (let i = 1; i <= n; i++) {
    spans.push(
      span({
        id: `t${i}`,
        name: `execute_tool tool_${i}`,
        parentId: 'root',
        startTime: i,
        endTime: i + 0.5,
        attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': `tool_${i}` },
        status: { code: 'ok' },
      })
    );
  }
  return spans;
}

describe('condenseTrace', () => {
  it('condenses the fixture into ordered steps with cost and errors', () => {
    const out = condenseTrace(FIXTURE);
    expect(out.status).toBe('ok');
    expect(out.durationMs).toBe(4000);
    expect(out.costUsd).toBeCloseTo(0.0073, 6);
    expect(out.errors).toEqual(['execute_tool charge_card: ToolExecutionError']);
    expect(out.steps.map((s) => s.kind)).toEqual(['model', 'tool', 'model', 'tool', 'subagent', 'handoff', 'guardrail']);
    const [model, tool, , failed, subagent] = out.steps;
    expect(model).toMatchObject({ name: 'anthropic/claude-sonnet-5-5', status: 'ok', durationMs: 900 });
    expect(tool).toMatchObject({ name: 'lookup_order', args: '{"orderId":"42"}', result: '{"status":"shipped"}' });
    expect(failed).toMatchObject({ name: 'charge_card', status: 'error', error: 'ToolExecutionError' });
    expect(subagent).toMatchObject({ name: 'shipping' });
    // The root invoke_agent is not a step.
    expect(out.steps.some((s) => s.name === 'invoke_agent support')).toBe(false);
  });

  it('uses the status message when a failed span has no error.type, and marks the trace error', () => {
    const out = condenseTrace([
      span({
        id: 'root',
        name: 'invoke_agent a',
        startTime: 0,
        endTime: 10,
        attributes: { 'gen_ai.operation.name': 'invoke_agent' },
        status: { code: 'error', message: 'model blew up' },
      }),
      span({
        id: 'x',
        name: 'execute_tool t',
        parentId: 'root',
        startTime: 1,
        endTime: 2,
        attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 't' },
        status: { code: 'error', message: 'it broke' },
      }),
    ]);
    expect(out.status).toBe('error');
    expect(out.errors).toEqual(['invoke_agent a: model blew up', 'execute_tool t: it broke']);
    expect(out.steps[0]).toMatchObject({ kind: 'tool', status: 'error', error: 'it broke' });
  });

  it('returns null cost when no chat span is priced and null duration for an unended root', () => {
    const out = condenseTrace([
      span({
        id: 'root',
        name: 'invoke_agent a',
        startTime: 5,
        attributes: { 'gen_ai.operation.name': 'invoke_agent' },
      }),
      span({
        id: 'c',
        name: 'chat m',
        parentId: 'root',
        startTime: 6,
        endTime: 8,
        attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'm' },
      }),
    ]);
    expect(out.costUsd).toBeNull();
    expect(out.durationMs).toBeNull();
  });

  it('clips captured args and result to 300 chars with an ellipsis', () => {
    const out = condenseTrace([
      span({
        id: 'root',
        name: 'invoke_agent a',
        startTime: 0,
        endTime: 10,
        attributes: { 'gen_ai.operation.name': 'invoke_agent' },
      }),
      span({
        id: 't',
        name: 'execute_tool t',
        parentId: 'root',
        startTime: 1,
        endTime: 2,
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 't',
          'gen_ai.tool.call.arguments': 'a'.repeat(400),
          'gen_ai.tool.call.result': 'r'.repeat(400),
        },
      }),
    ]);
    expect(out.steps[0].args).toBe(`${'a'.repeat(300)}…`);
    expect(out.steps[0].result).toBe(`${'r'.repeat(300)}…`);
  });

  it('keeps the first 60 steps and adds a "+N more steps" row beyond that', () => {
    const out = condenseTrace(toolSpans(TRACE_STEP_LIMIT + 10));
    expect(out.steps).toHaveLength(TRACE_STEP_LIMIT + 1);
    expect(out.steps[TRACE_STEP_LIMIT - 1]).toMatchObject({ kind: 'tool', name: `tool_${TRACE_STEP_LIMIT}` });
    expect(out.steps[TRACE_STEP_LIMIT]).toEqual({
      kind: 'other',
      name: '+10 more steps',
      status: 'ok',
      durationMs: null,
    });
  });
});

describe('getTrace', () => {
  function turn(): AuthorTurn {
    return {
      sessionId: 'sess-1',
      requestId: 'req-test',
      focus: { mode: 'create' },
      storedTranscript: [],
      userMessage: { id: 'm-1', role: 'user', text: 'hi', at: '2026-01-01T00:00:00.000Z' },
      signal: new AbortController().signal,
      stepsRemaining: () => 12,
      state: new Map(),
    };
  }

  function deps(root: string, repo: AgentRepo): AuthorToolDeps {
    return {
      workspace: async () => ({ ref: { root }, repo } as unknown as WorkspaceContext),
      catalog: {
        listModels: () => [],
        listTools: () => [],
        listGuardrails: () => [],
        listTriggerTypes: () => [],
        listSkills: async () => [],
        listKits: async () => [],
        listRegistryMcpServers: async () => [],
      } satisfies CatalogService,
      templates: { list: async () => [] },
      probeMcp: async () => ({ ok: true, tools: [] }),
      docsDir: '/nonexistent-docs',
      reviewDraft: passReview,
      requirements: async () => [],
      sessions: new AuthorSessionStore('/unused-sessions'),
      secrets: { secretStatus: (name) => ({ name, hasValue: false, masked: null, updatedAt: null }) },
    };
  }

  function tool(d: AuthorToolDeps): ToolDescriptor {
    const found = buildAuthorTools(turn(), d).find(
      (t) => ((t as { name?: string }).name ?? t.displayName) === 'getTrace'
    );
    if (found === undefined) throw new Error('getTrace not registered');
    return found;
  }

  async function call(t: ToolDescriptor, args: Record<string, unknown>): Promise<unknown> {
    return t.execute!(args as never, testToolContext({ toolCallId: 'call-1' }));
  }

  /** The fixture's spans as one real `.lousho` trace file for `agentId` under `root`. */
  async function workspaceWithTrace(agentId: string, traceId: string): Promise<{ root: string; repo: AgentRepo }> {
    const root = mkdtempSync(path.join(tmpdir(), 'aa20-trace-'));
    dirs.push(root);
    const repo = new AgentRepo(root);
    await repo.writeSpec(agentId, { version: 2, name: agentId, model: 'mock/mock-1', instructions: 'x' });
    const dir = path.join(agentTraceDir(root, agentId), '2026-01-02');
    mkdirSync(dir, { recursive: true });
    const lines = FIXTURE.map((s) => JSON.stringify({ v: 1, traceId, ...s }));
    writeFileSync(path.join(dir, `${traceId}.jsonl`), `${lines.join('\n')}\n`);
    return { root, repo };
  }

  it('reads a trace by id, searching every agent when agentId is omitted', async () => {
    const { root, repo } = await workspaceWithTrace('agent-a', 'trace-abc123');
    const out = (await call(tool(deps(root, repo)), { traceId: 'trace-abc123' })) as GetTraceOutput;
    expect(out.ok).toBe(true);
    expect(out.agentId).toBe('agent-a');
    expect(out.steps).toHaveLength(7);
    expect(out.costUsd).toBeCloseTo(0.0073, 6);
  });

  it('reads a trace scoped to one agent', async () => {
    const { root, repo } = await workspaceWithTrace('agent-a', 'trace-def456');
    const out = (await call(tool(deps(root, repo)), { traceId: 'trace-def456', agentId: 'agent-a' })) as GetTraceOutput;
    expect(out.ok).toBe(true);
    expect(out.agentId).toBe('agent-a');
  });

  it('an unknown trace is TRACE_NOT_FOUND, named for the agent when scoped', async () => {
    const { root, repo } = await workspaceWithTrace('agent-a', 'trace-abc123');
    const any = (await call(tool(deps(root, repo)), { traceId: 'trace-nope00' })) as AuthorToolFailure;
    expect(any).toMatchObject({ ok: false, code: 'TRACE_NOT_FOUND', error: 'No trace "trace-nope00" found.' });
    const scoped = (await call(tool(deps(root, repo)), {
      traceId: 'trace-nope00',
      agentId: 'agent-a',
    })) as AuthorToolFailure;
    expect(scoped).toMatchObject({ ok: false, code: 'TRACE_NOT_FOUND', error: 'No trace "trace-nope00" found for agent "agent-a".' });
  });

  it('a traversal-looking trace id is INVALID_INPUT', async () => {
    const { root, repo } = await workspaceWithTrace('agent-a', 'trace-abc123');
    const out = (await call(tool(deps(root, repo)), { traceId: '../../etc/passwd' })) as AuthorToolFailure;
    expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('a traversal-looking agent id is INVALID_INPUT before it can reach a path', async () => {
    const { root, repo } = await workspaceWithTrace('agent-a', 'trace-abc123');
    for (const agentId of ['../../outside', 'a..b', 'has space']) {
      const out = (await call(tool(deps(root, repo)), {
        traceId: 'trace-abc123',
        agentId,
      })) as AuthorToolFailure;
      expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    }
  });
});
