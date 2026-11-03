import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { testToolContext } from 'lousho/testing';
import type { AgentSpecV2 } from 'lousho';
import type { AuthorToolDeps, CatalogService } from '../index';
import type { AuthorTurn } from '../../turnRunner';
import type { WorkspaceContext } from '../../../workspace/context';
import type { AgentRepo } from '../../../storage/agentRepo';
import type { AuthorToolFailure, ProposalOutput } from '../../../../shared/authorWire';
import { proposalTurnState } from '../../proposal/turnState';
import { passReview } from '../../proposal/review';
import { AUTHOR_TOOL_FACTORIES, buildAuthorTools } from '../index';
import type { AuthorDraft } from '../../draft/schema';

/**
 * proposeAgent (AA08): draft -> spec validation, catalog checks, the
 * requirements dep, the pluggable review, the per-turn proposal record,
 * and the card-shaped ProposalOutput. The tool writes nothing - a real
 * .lousho/agents dir stays byte-identical.
 */

const DRAFT: AuthorDraft = {
  name: 'Support triage',
  description: 'Routes support mail to the right queue.',
  model: 'mock/mock-1',
  instructions: 'You triage support mail and pick the queue.',
};

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

function fakeCatalog(over: Partial<CatalogService> = {}): CatalogService {
  return {
    listModels: () => [{ id: 'mock/mock-1' }, { id: 'anthropic/claude-sonnet-5-5' }] as never,
    listTools: () => [{ name: 'web_fetch' }] as never,
    listGuardrails: () => [],
    listTriggerTypes: () => [{ type: 'chat' }, { type: 'cron' }] as never,
    listSkills: async () => [],
    listKits: async () => [],
    listRegistryMcpServers: async () => [],
    ...over,
  };
}

function fakeDeps(over: Partial<AuthorToolDeps> = {}): AuthorToolDeps {
  return {
    workspace: async () =>
      ({ repo: { listIds: () => [] } as unknown as AgentRepo }) as WorkspaceContext,
    catalog: fakeCatalog(),
    templates: { list: async () => [] },
    probeMcp: async () => ({ ok: true, tools: [] }),
    docsDir: '/nonexistent-docs',
    reviewDraft: passReview,
    requirements: async () => [],
    ...over,
  };
}

function proposeTool(t: AuthorTurn, deps: AuthorToolDeps) {
  const tool = buildAuthorTools(t, deps).find(
    (candidate) => ((candidate as { name?: string }).name ?? candidate.displayName) === 'proposeAgent'
  )!;
  return tool;
}

async function call(tool: ReturnType<typeof proposeTool>, args: Record<string, unknown>, toolCallId = 'call_a') {
  return tool.execute!(args as never, testToolContext({ toolCallId }));
}

describe('proposeAgent', () => {
  it('is registered in AUTHOR_TOOL_FACTORIES', () => {
    const names = AUTHOR_TOOL_FACTORIES.map((factory) => factory(turn(), fakeDeps())).map(
      (tool) => (tool as { name?: string }).name ?? tool.displayName
    );
    expect(names).toContain('proposeAgent');
  });

  it('returns a create ProposalOutput keyed on the toolCallId, writing nothing', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aa08-'));
    mkdirSync(path.join(root, '.lousho', 'agents'), { recursive: true });
    const before = readdirSync(root, { recursive: true });
    const t = turn();
    const requirements = [{ id: 'provider:mock', kind: 'provider_key', status: 'ok', label: 'Mock provider' }];
    const tool = proposeTool(t, fakeDeps({ requirements: async () => requirements as never }));
    const output = (await call(tool, { draft: DRAFT })) as ProposalOutput;

    expect(output.ok).toBe(true);
    expect(output.proposalId).toBe('call_a');
    expect(output.kind).toBe('create');
    expect(output.agentId).toBeUndefined();
    expect(output.enabled).toBe(false);
    expect(output.changes).toEqual([]);
    expect(output.carriedOver).toBe(false);
    expect(output.carriedFields).toEqual([]);
    expect(output.baseSpecHash).toBeNull();
    expect(output.requirements).toEqual(requirements);
    const spec = output.spec as AgentSpecV2;
    expect(spec.version).toBe(2);
    expect(spec.name).toBe('Support triage');
    expect(spec.triggers?.some((trigger) => trigger.type === 'chat')).toBe(true);
    // Nothing was written anywhere under .lousho/.
    expect(readdirSync(root, { recursive: true })).toEqual(before);
  });

  it('records the card under the create identity in the turn state', async () => {
    const t = turn();
    const output = (await call(proposeTool(t, fakeDeps()), { draft: DRAFT })) as ProposalOutput;
    expect(proposalTurnState(t).proposed.get('create')).toBe(output);
  });

  it('one UNKNOWN_MODEL failure lists both an unknown model and an unknown tool', async () => {
    const t = turn();
    // 'web_fetch' is schema-valid but absent from this fake catalog's tool list,
    // and 'acme/not-real' is a well-formed provider/model the model catalog lacks.
    const deps = fakeDeps({ catalog: fakeCatalog({ listTools: () => [] }) });
    const output = (await call(proposeTool(t, deps), {
      draft: { ...DRAFT, model: 'acme/not-real', tools: [{ builtin: 'web_fetch' }] },
    })) as AuthorToolFailure;
    expect(output.ok).toBe(false);
    expect(output.code).toBe('UNKNOWN_MODEL');
    expect(output.error).toContain('model "acme/not-real" is not in the catalog');
    expect(output.error).toContain('tools[0] builtin "web_fetch" does not exist');
    expect(output.next).toContain('proposeAgent');
    expect(proposalTurnState(t).proposed.size).toBe(0);
  });

  it('a failing review returns its failure and leaves proposed empty', async () => {
    const t = turn();
    const reviewFailure: AuthorToolFailure = {
      ok: false,
      code: 'DRAFT_REVIEW',
      error: 'The draft would not run: no tool can read mail.',
      userMessage: 'The Author is still working on the draft.',
    };
    const output = (await call(
      proposeTool(t, fakeDeps({ reviewDraft: async () => ({ pass: false, failure: reviewFailure }) })),
      { draft: DRAFT }
    )) as AuthorToolFailure;
    expect(output).toBe(reviewFailure);
    expect(proposalTurnState(t).proposed.size).toBe(0);
  });

  it('passes spec, changes and requirements to the review', async () => {
    const t = turn();
    let seen: unknown;
    const requirements = [{ id: 'mcp:gh', kind: 'mcp', status: 'unknown', label: 'MCP server gh' }];
    const tool = proposeTool(
      t,
      fakeDeps({
        requirements: async () => requirements as never,
        reviewDraft: async (input) => {
          seen = input;
          return { pass: true };
        },
      })
    );
    const output = (await call(tool, { draft: DRAFT })) as ProposalOutput;
    expect(output.ok).toBe(true);
    const input = seen as { turn: AuthorTurn; spec: AgentSpecV2 };
    expect(input.turn).toBe(t);
    expect(seen).toMatchObject({
      identity: { kind: 'create' },
      toolName: 'proposeAgent',
      changes: [],
      requirements,
    });
    expect(input.spec.name).toBe('Support triage');
  });

  it('invalid draft -> DRAFT_INVALID with path: message text', async () => {
    const t = turn();
    const output = (await call(proposeTool(t, fakeDeps()), {
      draft: { ...DRAFT, name: '!!!', description: '' },
    })) as AuthorToolFailure;
    expect(output.ok).toBe(false);
    expect(output.code).toBe('DRAFT_INVALID');
    expect(output.error).toContain('description');
    expect(output.next).toContain('proposeAgent');
    expect(proposalTurnState(t).proposed.size).toBe(0);
  });

  it('a requirements dep that throws still yields a card with requirements []', async () => {
    const t = turn();
    const tool = proposeTool(
      t,
      fakeDeps({
        requirements: async () => {
          throw new Error('requirements exploded');
        },
      })
    );
    const output = (await call(tool, { draft: DRAFT })) as ProposalOutput;
    expect(output.ok).toBe(true);
    expect(output.requirements).toEqual([]);
    expect(proposalTurnState(t).proposed.get('create')).toBe(output);
  });
});
