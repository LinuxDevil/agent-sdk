import { describe, expect, it } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import type { AuthorToolDeps, CatalogService } from '../../tools/index';
import type { AuthorTurn } from '../../turnRunner';
import type { WorkspaceContext } from '../../../workspace/context';
import type { AgentRepo } from '../../../storage/agentRepo';
import type { AuthorToolFailure } from '../../../../shared/authorWire';
import { AuthorSessionStore } from '../../sessionStore';
import { checkCatalogs, loadCatalogFacts, type CatalogFacts } from '../catalogChecks';

/**
 * The catalog checks proposeAgent/proposeAgentUpdate run between schema
 * validation and requirements: every value the draft names that must
 * exist in Studio's catalogs is collected into one failure (first
 * problem's code wins), and the per-turn memoization of the facts load.
 */

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

function spec(over: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return {
    version: 2,
    name: 'Test agent',
    description: 'does a thing',
    model: 'anthropic/claude-sonnet-5-5',
    instructions: 'do a thing',
    ...over,
  };
}

function facts(over: Partial<CatalogFacts> = {}): CatalogFacts {
  return {
    modelIds: new Set(['anthropic/claude-sonnet-5-5', 'openai/gpt-5']),
    builtinTools: new Set(['web_fetch', 'run_command']),
    guardrails: new Set(['pii', 'regex']),
    triggerTypes: new Set(['chat', 'cron', 'webhook', 'channel', 'agent']),
    agentIds: new Set(['billing-bot', 'support-triage']),
    ...over,
  };
}

function failure(result: AuthorToolFailure | null): AuthorToolFailure {
  expect(result).not.toBeNull();
  expect(result!.ok).toBe(false);
  return result!;
}

describe('checkCatalogs', () => {
  it('returns null when every catalog value exists', () => {
    const ok = spec({
      fallbackModels: ['openai/gpt-5'],
      tools: [{ builtin: 'web_fetch' }],
      guardrails: [{ id: 'g1', name: 'pii' }],
      triggers: [{ id: 't1', type: 'chat' }, { id: 't2', type: 'cron', cron: '0 9 * * 1', prompt: 'go' }],
      subagents: { helper: { ref: 'billing-bot' } },
      handoffs: [{ agent: 'support-triage' }],
    });
    expect(checkCatalogs(ok, facts(), 'proposeAgent')).toBeNull();
  });

  it('UNKNOWN_MODEL when the first problem is a model not in the catalog', () => {
    const result = failure(checkCatalogs(spec({ model: 'acme/not-real' }), facts(), 'proposeAgent'));
    expect(result.code).toBe('UNKNOWN_MODEL');
    expect(result.error).toBe('Some values are not in Studio\'s catalogs: model "acme/not-real" is not in the catalog.');
  });

  it('flags each fallback model that is not in the catalog', () => {
    const result = failure(
      checkCatalogs(spec({ fallbackModels: ['acme/gone-1', 'openai/gpt-5', 'acme/gone-2'] }), facts(), 'proposeAgent')
    );
    expect(result.code).toBe('UNKNOWN_MODEL');
    expect(result.error).toContain('model "acme/gone-1" is not in the catalog');
    expect(result.error).toContain('model "acme/gone-2" is not in the catalog');
    expect(result.error).not.toContain('openai/gpt-5');
  });

  it('UNKNOWN_TOOL for a builtin name the catalog lacks', () => {
    const result = failure(
      checkCatalogs(spec({ tools: [{ builtin: 'web_fetch' }, { builtin: 'not-a-tool' }] }), facts(), 'proposeAgent')
    );
    expect(result.code).toBe('UNKNOWN_TOOL');
    expect(result.error).toBe('Some values are not in Studio\'s catalogs: tools[1] builtin "not-a-tool" does not exist.');
  });

  it('UNKNOWN_GUARDRAIL for a guardrail name the catalog lacks', () => {
    const result = failure(
      checkCatalogs(spec({ guardrails: [{ id: 'g1', name: 'pii' }, { id: 'g2', name: 'not-a-guardrail' as never }] }), facts(), 'proposeAgent')
    );
    expect(result.code).toBe('UNKNOWN_GUARDRAIL');
    expect(result.error).toContain('guardrails[1] name "not-a-guardrail" does not exist');
  });

  it('UNKNOWN_TRIGGER_TYPE for a trigger type the catalog lacks', () => {
    const result = failure(
      checkCatalogs(spec({ triggers: [{ id: 't1', type: 'chat' }, { id: 't2', type: 'smoke' as never }] }), facts(), 'proposeAgent')
    );
    expect(result.code).toBe('UNKNOWN_TRIGGER_TYPE');
    expect(result.error).toContain('triggers[1] type "smoke" does not exist');
  });

  it('UNKNOWN_AGENT_REF for a subagents.<key>.ref that is not a workspace agent', () => {
    const result = failure(
      checkCatalogs(spec({ subagents: { helper: { ref: 'billing-bot' }, ghost: { ref: 'gone' } } }), facts(), 'proposeAgent')
    );
    expect(result.code).toBe('UNKNOWN_AGENT_REF');
    expect(result.error).toContain('subagents.ghost.ref agent "gone" does not exist');
  });

  it('UNKNOWN_AGENT_REF for a handoffs[i].agent that is not a workspace agent', () => {
    const result = failure(checkCatalogs(spec({ handoffs: [{ agent: 'gone' }] }), facts(), 'proposeAgent'));
    expect(result.code).toBe('UNKNOWN_AGENT_REF');
    expect(result.error).toContain('handoffs[0].agent agent "gone" does not exist');
  });

  it('allows a handoff to one of the spec\'s own subagent keys', () => {
    const ok = spec({
      subagents: { helper: { inline: { name: 'Helper', model: 'anthropic/claude-sonnet-5-5', instructions: 'help', description: 'helps' } } },
      handoffs: [{ agent: 'helper' }],
    });
    expect(checkCatalogs(ok, facts(), 'proposeAgent')).toBeNull();
  });

  it('the first problem in check order picks the code; every problem is listed', () => {
    const result = failure(
      checkCatalogs(spec({ model: 'acme/not-real', tools: [{ builtin: 'not-a-tool' }] }), facts(), 'proposeAgent')
    );
    expect(result.code).toBe('UNKNOWN_MODEL');
    expect(result.error).toContain('model "acme/not-real" is not in the catalog');
    expect(result.error).toContain('tools[0] builtin "not-a-tool" does not exist');
    expect(result.userMessage).toBe("The draft referred to something Studio doesn't have. The Author is fixing it.");
    expect(result.next).toBe(
      'Call listModels, listTools, listGuardrails, listTriggerTypes or listAgents and copy exact values, then call proposeAgent again.'
    );
  });

  it('lists at most the first 10 problems', () => {
    const many = spec({ tools: Array.from({ length: 12 }, (_, i) => ({ builtin: `tool-${i}` })) });
    const result = failure(checkCatalogs(many, facts(), 'proposeAgent'));
    expect(result.code).toBe('UNKNOWN_TOOL');
    expect(result.error).toContain('tools[9] builtin "tool-9" does not exist');
    expect(result.error).not.toContain('tools[10]');
    expect(result.error).not.toContain('tool-11');
  });
});

describe('loadCatalogFacts', () => {
  function deps(agentIds: string[], catalog: Partial<CatalogService> = {}): AuthorToolDeps {
    return {
      workspace: async () =>
        ({ repo: { listIds: () => agentIds } as unknown as AgentRepo }) as WorkspaceContext,
      catalog: {
        listModels: () => [{ id: 'anthropic/claude-sonnet-5-5' }] as never,
        listTools: () => [{ name: 'web_fetch' }] as never,
        listGuardrails: () => [{ name: 'pii' }] as never,
        listTriggerTypes: () => [{ type: 'chat' }] as never,
        listSkills: async () => [],
        listKits: async () => [],
        listRegistryMcpServers: async () => [],
        ...catalog,
      },
      templates: { list: async () => [] },
      probeMcp: async () => ({ ok: true, tools: [] }),
      docsDir: '/nonexistent-docs',
      reviewDraft: async () => ({ pass: true }),
      requirements: async () => [],
      sessions: new AuthorSessionStore('/unused-sessions'),
    };
  }

  it('reads ids from the catalog service and the workspace repo', async () => {
    const loaded = await loadCatalogFacts(turn(), deps(['billing-bot']));
    expect(loaded).toEqual({
      modelIds: new Set(['anthropic/claude-sonnet-5-5']),
      builtinTools: new Set(['web_fetch']),
      guardrails: new Set(['pii']),
      triggerTypes: new Set(['chat']),
      agentIds: new Set(['billing-bot']),
    });
  });

  it('memoizes per turn: a second call never re-reads the catalog', async () => {
    let modelCalls = 0;
    const t = turn();
    const d = deps(['a'], {
      listModels: () => {
        modelCalls += 1;
        return [{ id: 'anthropic/claude-sonnet-5-5' }] as never;
      },
    });
    const first = await loadCatalogFacts(t, d);
    const second = await loadCatalogFacts(t, d);
    expect(modelCalls).toBe(1);
    expect(second).toBe(first);
  });

  it('does not share the memo across turns', async () => {
    const loaded = await loadCatalogFacts(turn(), deps(['a']));
    const other = await loadCatalogFacts(turn(), deps(['b']));
    expect([...loaded.agentIds]).toEqual(['a']);
    expect([...other.agentIds]).toEqual(['b']);
  });
});
