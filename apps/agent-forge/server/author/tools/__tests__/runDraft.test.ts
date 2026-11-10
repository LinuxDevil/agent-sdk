import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testToolContext } from 'lousho/testing';
import { ConfigurationError, type AgentSpecV2, type ToolDescriptor } from 'lousho';
import { AlreadyRunningError, RunManager } from '../../../runRegistry';
import { readAgentTrace } from '../../../traceStore';
import { AgentRepo } from '../../../storage/agentRepo';
import { FileCheckpointStore } from '../../../checkpointStore';
import { FileApprovalStore } from '../../../approvalStore';
import { newTestHost } from '../../../__tests__/testHost';
import { StudioEventBus } from '../../../events/eventBus';
import { AuthorSessionStore } from '../../sessionStore';
import { passReview } from '../../proposal/review';
import { buildAuthorTools, type AuthorToolDeps, type CatalogService } from '../index';
import { RUN_DRAFT_TIMEOUT_MS, type RunDraftOutput } from '../runDraftTool';
import type { AuthorTurn } from '../../turnRunner';
import type { WorkspaceContext } from '../../../workspace/context';
import type { AuthorToolFailure } from '../../../../shared/authorWire';
import type { AgentRunStatusPayload } from '../../../../shared/wireTypes';

/**
 * `runDraft` (AA20): one run of an agent's saved working copy through
 * the session workspace's own RunManager, capped at 60 s. The 'done'
 * case runs a real RunManager over a temp workspace and the mock
 * provider; timeout/busy/failed/awaiting-approval use a fake one that
 * emits the `status` payloads the tool waits on.
 */

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'Draft runner',
  model: 'mock/mock-1',
  instructions: 'You are a helpful agent.',
};

/** A gated spec whose tool call pauses the run awaiting approval (same shape as inProcessAgentHost.test.ts's GATED). */
const GATED: AgentSpecV2 = {
  ...SPEC,
  tools: [{ builtin: 'current_date' }],
  permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
};

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function turn(signal?: AbortSignal): AuthorTurn {
  return {
    sessionId: 'sess-1',
    requestId: 'req-test',
    focus: { mode: 'edit', agentId: 'agent-a' },
    storedTranscript: [],
    userMessage: { id: 'm-1', role: 'user', text: 'test it', at: '2026-01-01T00:00:00.000Z' },
    signal: signal ?? new AbortController().signal,
    stepsRemaining: () => 12,
    state: new Map(),
  };
}

function deps(ctx: Partial<WorkspaceContext>): AuthorToolDeps {
  return {
    workspace: async () => ctx as WorkspaceContext,
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

function tool(t: AuthorTurn, d: AuthorToolDeps): ToolDescriptor {
  const found = buildAuthorTools(t, d).find(
    (candidate) => ((candidate as { name?: string }).name ?? candidate.displayName) === 'runDraft'
  );
  if (found === undefined) throw new Error('runDraft not registered');
  return found;
}

async function call(t: ToolDescriptor, args: Record<string, unknown>): Promise<unknown> {
  return t.execute!(args as never, testToolContext({ toolCallId: 'call-1' }));
}

/** A real RunManager on a temp workspace with `agent-a` saved (mock provider). */
async function realWorkspace(spec: AgentSpecV2 = SPEC, agentId = 'agent-a'): Promise<{ root: string; repo: AgentRepo; runs: RunManager }> {
  const root = mkdtempSync(path.join(tmpdir(), 'aa20-run-'));
  dirs.push(root);
  const repo = new AgentRepo(root);
  await repo.writeSpec(agentId, spec);
  const runs = new RunManager({
    baseDir: root,
    checkpointStore: new FileCheckpointStore(root),
    approvalStore: new FileApprovalStore(root),
    host: newTestHost(root),
    loadSpec: (agentId) => repo.readSpec(agentId),
  });
  return { root, repo, runs };
}

function context(partial: Partial<WorkspaceContext>): WorkspaceContext {
  return {
    ref: { id: 'ws-1', name: 'ws', root: '/unused', addedAt: 'x', lastOpenedAt: 'x' },
    repo: { exists: () => true, listIds: () => [] },
    events: new StudioEventBus(),
    ...partial,
  } as unknown as WorkspaceContext;
}

/** A RunManager-shaped fake: `status`/`run`/`stop`/`approve` are spies, `status` events drive the wait. */
class FakeRuns extends EventEmitter {
  status = vi.fn((agentId: string): AgentRunStatusPayload => ({
    agentId,
    status: 'idle',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
  run = vi.fn<[agentId: string, input: string], Promise<void>>(async () => {});
  stop = vi.fn<[agentId: string], void>(() => {});
  approve = vi.fn<[agentId: string, approvalId: string, approved: boolean, note?: string], Promise<void>>(
    async () => {}
  );
  asManager(): RunManager {
    return this as unknown as RunManager;
  }
}

function fakeDeps(runs: FakeRuns, exists = true): AuthorToolDeps {
  const repo = { exists: () => exists, listIds: () => [] } as unknown as AgentRepo;
  return deps(context({ repo, runs: runs.asManager() }));
}

describe('runDraft', () => {
  it('runs a saved mock-provider agent once: done, its text and a trace id', async () => {
    const { root, repo, runs } = await realWorkspace();
    const out = (await call(tool(turn(), deps(context({ ref: { root } as never, repo, runs }))), {
      agentId: 'agent-a',
      input: 'say hi',
    })) as RunDraftOutput;
    expect(out).toMatchObject({ ok: true, agentId: 'agent-a', status: 'done', resultText: 'This is a mock response.', errors: [] });
    expect(typeof out.traceId).toBe('string');
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    // The run's trace file is on disk, so getTrace can read it by the returned id.
    expect((await readAgentTrace(root, 'agent-a', out.traceId!)).length).toBeGreaterThan(0);
  });

  it('a run that never ends returns timeout after 60 s and the run is stopped', async () => {
    vi.useFakeTimers();
    try {
      const runs = new FakeRuns();
      const promise = call(tool(turn(), fakeDeps(runs)), { agentId: 'agent-a', input: 'hang' });
      await vi.advanceTimersByTimeAsync(RUN_DRAFT_TIMEOUT_MS);
      const out = (await promise) as RunDraftOutput;
      expect(out).toMatchObject({ ok: true, status: 'timeout', traceId: null, errors: [] });
      expect(runs.stop).toHaveBeenCalledWith('agent-a');
      expect(out.durationMs).toBe(RUN_DRAFT_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an already-running agent is RUN_BUSY, and so is a run() that throws AlreadyRunningError', async () => {
    const running = new FakeRuns();
    running.status.mockReturnValue({
      agentId: 'agent-a',
      status: 'running',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const busy = (await call(tool(turn(), fakeDeps(running)), { agentId: 'agent-a', input: 'hi' })) as AuthorToolFailure;
    expect(busy).toMatchObject({ ok: false, code: 'RUN_BUSY' });
    expect(running.run).not.toHaveBeenCalled();

    const racing = new FakeRuns();
    racing.run.mockRejectedValue(new AlreadyRunningError('already running'));
    const raced = (await call(tool(turn(), fakeDeps(racing)), { agentId: 'agent-a', input: 'hi' })) as AuthorToolFailure;
    expect(raced).toMatchObject({ ok: false, code: 'RUN_BUSY' });
  });

  it('a missing agent is AGENT_NOT_FOUND and a start failure is RUN_FAILED with the code', async () => {
    const gone = new FakeRuns();
    const missing = (await call(tool(turn(), fakeDeps(gone, false)), { agentId: 'nope', input: 'hi' })) as AuthorToolFailure;
    expect(missing).toMatchObject({ ok: false, code: 'AGENT_NOT_FOUND' });
    expect(gone.run).not.toHaveBeenCalled();

    const noKey = new FakeRuns();
    noKey.run.mockRejectedValue(
      new ConfigurationError("No API key for provider 'openai'.", 'model', 'LOUSHO_PROVIDER_MISSING_API_KEY')
    );
    const failed = (await call(tool(turn(), fakeDeps(noKey)), { agentId: 'agent-a', input: 'hi' })) as AuthorToolFailure;
    expect(failed).toMatchObject({ ok: false, code: 'RUN_FAILED' });
    expect(failed.error).toContain('LOUSHO_PROVIDER_MISSING_API_KEY');
    expect(failed.error).toContain("No API key for provider 'openai'.");
  });

  it('a run that pauses for approval reports awaiting_approval, releases the pause and stops', async () => {
    const runs = new FakeRuns();
    runs.run.mockImplementation(async (agentId: string) => {
      runs.emit('status', {
        agentId,
        status: 'paused',
        reason: 'awaiting_approval',
        pendingApproval: { approvalId: 'ap-1', toolName: 'charge_card', args: {}, createdAt: 'x', kind: 'tool', deadline: 'x' },
        updatedAt: 'x',
      } satisfies AgentRunStatusPayload);
    });
    const out = (await call(tool(turn(), fakeDeps(runs)), { agentId: 'agent-a', input: 'charge me' })) as RunDraftOutput;
    expect(out).toMatchObject({ ok: true, status: 'awaiting_approval' });
    expect(out.errors).toEqual(['Waiting for approval of charge_card; the test run was stopped.']);
    expect(runs.stop).toHaveBeenCalledWith('agent-a');
  });

  it('a real run paused for approval is stopped - the entry cannot stay permanently paused', async () => {
    const { root, repo, runs } = await realWorkspace(GATED, 'gated');
    const ctx = context({ ref: { root } as never, repo, runs });
    const out = (await call(tool(turn(), deps(ctx)), {
      agentId: 'gated',
      input: 'please use current_date',
    })) as RunDraftOutput;
    expect(out).toMatchObject({ ok: true, status: 'awaiting_approval' });
    expect(out.errors[0]).toContain('current_date');
    // The paused run is really gone: the entry is stopped and the next runDraft is not RUN_BUSY.
    expect(runs.status('gated').status).toBe('stopped');
    const again = (await call(tool(turn(), deps(ctx)), { agentId: 'gated', input: 'hi' })) as RunDraftOutput;
    expect(again.ok).toBe(true);
    expect(again.status).not.toBe('awaiting_approval');
  });

  it('an already-aborted turn starts no run and reports stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    const runs = new FakeRuns();
    const out = (await call(tool(turn(controller.signal), fakeDeps(runs)), {
      agentId: 'agent-a',
      input: 'hi',
    })) as RunDraftOutput;
    expect(out).toMatchObject({ ok: true, status: 'stopped', traceId: null });
    expect(runs.run).not.toHaveBeenCalled();
    expect(runs.stop).not.toHaveBeenCalled();
  });

  it('a run ending in error reports error with the run error, and a long result is clipped', async () => {
    const runs = new FakeRuns();
    runs.run.mockImplementation(async (agentId: string) => {
      runs.emit('status', {
        agentId,
        status: 'error',
        error: 'model blew up',
        traceId: 'trace-1',
        updatedAt: 'x',
      } satisfies AgentRunStatusPayload);
    });
    const out = (await call(tool(turn(), fakeDeps(runs)), { agentId: 'agent-a', input: 'hi' })) as RunDraftOutput;
    expect(out).toMatchObject({ ok: true, status: 'error', traceId: 'trace-1', errors: ['model blew up'] });

    const chatty = new FakeRuns();
    chatty.run.mockImplementation(async (agentId: string) => {
      chatty.emit('status', {
        agentId,
        status: 'done',
        resultText: 'x'.repeat(4100),
        updatedAt: 'x',
      } satisfies AgentRunStatusPayload);
    });
    const clipped = (await call(tool(turn(), fakeDeps(chatty)), { agentId: 'agent-a', input: 'hi' })) as RunDraftOutput;
    expect(clipped.resultText).toBe(`${'x'.repeat(4000)}…`);
  });

  it('aborting the turn stops the run and reports stopped', async () => {
    const controller = new AbortController();
    const runs = new FakeRuns();
    runs.run.mockImplementation(async () => controller.abort());
    const out = (await call(tool(turn(controller.signal), fakeDeps(runs)), {
      agentId: 'agent-a',
      input: 'hi',
    })) as RunDraftOutput;
    expect(out).toMatchObject({ ok: true, status: 'stopped' });
    expect(runs.stop).toHaveBeenCalledWith('agent-a');
  });
});
