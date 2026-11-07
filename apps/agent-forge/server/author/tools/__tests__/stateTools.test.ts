import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testToolContext } from 'lousho/testing';
import type { AgentSpecV2, ToolDescriptor } from 'lousho';
import { buildAuthorTools, type AuthorToolDeps, type CatalogService } from '../index';
import type { AuthorTurn } from '../../turnRunner';
import type { WorkspaceContext } from '../../../workspace/context';
import { AgentRepo, defaultMeta } from '../../../storage/agentRepo';
import { StudioEventBus } from '../../../events/eventBus';
import { identityKey, proposalTurnState } from '../../proposal/turnState';
import { passReview } from '../../proposal/review';
import { AuthorSessionStore } from '../../sessionStore';
import type {
  AuthorToolFailure,
  ProposalOutput,
  Requirement,
  SetEnabledOutput,
} from '../../../../shared/authorWire';
import type { StudioEvent } from '../../../../shared/wireTypes';

/**
 * discardPendingChanges + setAgentEnabled (AA11): the discard drops an
 * identity's unsaved cards from THIS turn's proposal record (its ok part
 * in the stored transcript resets the AA10a gate the same way), and the
 * enable switch writes meta.enabled directly - no card, no turn gate -
 * through the same `setAgentEnabledFor` the SuccessCard route uses.
 */

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'Support triage',
  model: 'mock/mock-1',
  instructions: 'You triage support mail.',
  triggers: [{ id: 't1', type: 'chat' }],
};

const UPDATE_KEY = identityKey({ kind: 'update', agentId: 'agent-a' });
const CREATE_KEY = identityKey({ kind: 'create' });

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A workspace rooted in a fresh tmpdir with `agent-a` already saved. */
async function workspace(): Promise<{ root: string; repo: AgentRepo; bus: StudioEventBus }> {
  const root = mkdtempSync(path.join(tmpdir(), 'aa11-'));
  dirs.push(root);
  const repo = new AgentRepo(root);
  await repo.writeSpec('agent-a', SPEC);
  await repo.writeMeta('agent-a', { ...defaultMeta('2026-01-01T00:00:00.000Z'), enabled: true });
  return { root, repo, bus: new StudioEventBus() };
}

function turn(): AuthorTurn {
  return {
    sessionId: 'sess-1',
    requestId: 'req-test',
    focus: { mode: 'edit', agentId: 'agent-a' },
    storedTranscript: [],
    userMessage: { id: 'm-1', role: 'user', text: 'do it', at: '2026-01-01T00:00:00.000Z' },
    signal: new AbortController().signal,
    stepsRemaining: () => 12,
    state: new Map(),
  };
}

function fakeCatalog(): CatalogService {
  return {
    listModels: () => [{ id: 'mock/mock-1' }] as never,
    listTools: () => [] as never,
    listGuardrails: () => [],
    listTriggerTypes: () => [{ type: 'chat' }] as never,
    listSkills: async () => [],
    listKits: async () => [],
    listRegistryMcpServers: async () => [],
  };
}

function fakeDeps(
  ws: { repo: AgentRepo; bus: StudioEventBus },
  over: Partial<AuthorToolDeps> = {}
): AuthorToolDeps {
  return {
    workspace: async () => ({ repo: ws.repo, events: ws.bus } as unknown as WorkspaceContext),
    catalog: fakeCatalog(),
    templates: { list: async () => [] },
    probeMcp: async () => ({ ok: true, tools: [] }),
    docsDir: '/nonexistent-docs',
    reviewDraft: passReview,
    requirements: async () => [],
    sessions: new AuthorSessionStore('/unused-sessions'),
    secrets: { secretStatus: (name) => ({ name, hasValue: false, masked: null, updatedAt: null }) },
    ...over,
  };
}

function toolNamed(t: AuthorTurn, deps: AuthorToolDeps, name: string): ToolDescriptor {
  const found = buildAuthorTools(t, deps).find(
    (candidate) => ((candidate as { name?: string }).name ?? candidate.displayName) === name
  );
  if (found === undefined) throw new Error(`tool ${name} not registered`);
  return found;
}

async function call(tool: ToolDescriptor, args: Record<string, unknown>): Promise<unknown> {
  return tool.execute!(args as never, testToolContext({ toolCallId: 'call_a' }));
}

/** A minimal ok card as `proposed` records it (only identity plumbing matters here). */
function fakeCard(agentId?: string): ProposalOutput {
  return {
    ok: true,
    proposalId: 'call_card',
    kind: agentId === undefined ? 'create' : 'update',
    ...(agentId !== undefined && { agentId }),
    spec: SPEC,
    changes: [],
    requirements: [],
    carriedOver: false,
    carriedFields: [],
    baseSpecHash: null,
    enabled: true,
  };
}

describe('discardPendingChanges', () => {
  it('drops this turn\'s update card for the agent and marks the identity discarded', async () => {
    const ws = await workspace();
    const t = turn();
    proposalTurnState(t).proposed.set(UPDATE_KEY, fakeCard('agent-a'));
    const out = (await call(toolNamed(t, fakeDeps(ws), 'discardPendingChanges'), {
      agentId: 'agent-a',
    })) as { ok: true; agentId: string; message: string };
    expect(out).toEqual({
      ok: true,
      agentId: 'agent-a',
      message:
        'Unsaved changes for this agent were discarded. Nothing was saved. The next proposal starts from the saved agent.',
    });
    expect(proposalTurnState(t).proposed.has(UPDATE_KEY)).toBe(false);
    expect(proposalTurnState(t).discarded.has(UPDATE_KEY)).toBe(true);
  });

  it('without agentId drops only the create card - an update card survives', async () => {
    const ws = await workspace();
    const t = turn();
    const state = proposalTurnState(t);
    state.proposed.set(UPDATE_KEY, fakeCard('agent-a'));
    state.proposed.set(CREATE_KEY, fakeCard());
    const out = (await call(toolNamed(t, fakeDeps(ws), 'discardPendingChanges'), {})) as {
      ok: true;
      agentId?: string;
      message: string;
    };
    expect(out).toEqual({ ok: true, message: 'The unsaved new-agent card was discarded. Nothing was saved.' });
    const after = proposalTurnState(t);
    expect(after.proposed.has(CREATE_KEY)).toBe(false);
    expect(after.discarded.has(CREATE_KEY)).toBe(true);
    expect(after.proposed.has(UPDATE_KEY)).toBe(true);
    expect(after.discarded.has(UPDATE_KEY)).toBe(false);
  });

  it('refuses AGENT_NOT_FOUND for an update identity that is not on disk', async () => {
    const ws = await workspace();
    const t = turn();
    const out = (await call(toolNamed(t, fakeDeps(ws), 'discardPendingChanges'), {
      agentId: 'ghost',
    })) as AuthorToolFailure;
    expect(out).toMatchObject({ ok: false, code: 'AGENT_NOT_FOUND' });
    expect(proposalTurnState(t).discarded.size).toBe(0);
  });
});

describe('setAgentEnabled', () => {
  it('refuses AGENT_NOT_FOUND for an unknown agent', async () => {
    const ws = await workspace();
    const t = turn();
    const out = (await call(toolNamed(t, fakeDeps(ws), 'setAgentEnabled'), {
      agentId: 'ghost',
      enabled: false,
    })) as AuthorToolFailure;
    expect(out).toMatchObject({ ok: false, code: 'AGENT_NOT_FOUND' });
  });

  it('reports unchanged (and writes nothing) when the agent already has that state', async () => {
    const ws = await workspace();
    const before = await ws.repo.readMeta('agent-a');
    const events: StudioEvent[] = [];
    ws.bus.subscribe((event) => events.push(event));
    const t = turn();
    const out = (await call(toolNamed(t, fakeDeps(ws), 'setAgentEnabled'), {
      agentId: 'agent-a',
      enabled: true,
    })) as SetEnabledOutput;
    expect(out).toEqual({ ok: true, agentId: 'agent-a', enabled: true, status: 'unchanged', missingRequirements: 0 });
    expect(await ws.repo.readMeta('agent-a')).toEqual(before);
    expect(events).toEqual([]);
  });

  it('disabling stamps disabledAt and disabledReason manual and publishes agent.changed', async () => {
    const ws = await workspace();
    const events: StudioEvent[] = [];
    ws.bus.subscribe((event) => events.push(event));
    const t = turn();
    const out = (await call(toolNamed(t, fakeDeps(ws), 'setAgentEnabled'), {
      agentId: 'agent-a',
      enabled: false,
    })) as SetEnabledOutput;
    expect(out).toMatchObject({ ok: true, agentId: 'agent-a', enabled: false, status: 'updated' });
    const meta = await ws.repo.readMeta('agent-a');
    expect(meta.enabled).toBe(false);
    expect(meta.disabledReason).toBe('manual');
    expect(meta.disabledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(events).toEqual([{ type: 'agent.changed', agentId: 'agent-a', reason: 'meta' }]);
  });

  it('enabling clears the disable fields and the failure streak', async () => {
    const ws = await workspace();
    await ws.repo.writeMeta('agent-a', {
      ...defaultMeta('2026-01-01T00:00:00.000Z'),
      enabled: false,
      disabledAt: '2026-01-02T00:00:00.000Z',
      disabledReason: 'auto_failure_streak',
      failureStreak: 4,
    });
    const t = turn();
    const out = (await call(toolNamed(t, fakeDeps(ws), 'setAgentEnabled'), {
      agentId: 'agent-a',
      enabled: true,
    })) as SetEnabledOutput;
    expect(out).toMatchObject({ ok: true, status: 'updated', enabled: true });
    const meta = await ws.repo.readMeta('agent-a');
    expect(meta).toMatchObject({ enabled: true, disabledAt: null, disabledReason: null, failureStreak: 0 });
  });

  it('counts only missing readiness rows in missingRequirements', async () => {
    const ws = await workspace();
    const rows: Requirement[] = [
      { id: 'secret:A', kind: 'secret', status: 'missing', label: 'A' },
      { id: 'mcp:x', kind: 'mcp', status: 'unknown', label: 'x' },
      { id: 'provider:mock', kind: 'provider_key', status: 'ok', label: 'p' },
      { id: 'secret:B', kind: 'secret', status: 'missing', label: 'B' },
    ];
    const t = turn();
    const out = (await call(toolNamed(t, fakeDeps(ws, { requirements: async () => rows }), 'setAgentEnabled'), {
      agentId: 'agent-a',
      enabled: false,
    })) as SetEnabledOutput;
    expect(out.missingRequirements).toBe(2);
  });
});
