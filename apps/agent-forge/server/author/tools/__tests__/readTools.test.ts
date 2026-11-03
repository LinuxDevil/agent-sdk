import { describe, it, expect } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import type { AgentRepo } from '../../../storage/agentRepo';
import type { VersionStore } from '../../../storage/versionStore';
import type { WorkspaceContext } from '../../../workspace/context';
import type { AgentMeta, CatalogGuardrail, CatalogKit, CatalogModel, CatalogSkill, CatalogTool, CatalogTriggerType, McpServerSpecV2, TemplateSummary } from '../../../../shared/wireTypes';
import { AUTHOR_TOOL_NAMES } from '../../toolNames';
import type { AuthorTurn } from '../../turnRunner';
import { AUTHOR_TOOL_FACTORIES, buildAuthorTools, type AuthorToolDeps, type CatalogService } from '../index';
import type { AuthorToolFailure } from '../../../../shared/authorWire';

/**
 * The 13 Author read tools (AA06): happy paths against in-memory fakes of
 * AgentRepo/the catalog service/the template service, the shared paging
 * contract, and the { ok:false, code, error, userMessage, next? } failure
 * shape every tool returns instead of throwing.
 */

const TURN: AuthorTurn = {
  sessionId: 'sess-1',
  requestId: 'req-test',
  focus: { mode: 'create' },
  storedTranscript: [],
  userMessage: { id: 'm-1', role: 'user', text: 'hi', at: '2026-01-01T00:00:00.000Z' },
  signal: new AbortController().signal,
  stepsRemaining: () => 12,
  state: new Map(),
};

function spec(over: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return { version: 2, name: 'Test agent', model: 'mock/mock-1', instructions: 'do a thing', ...over };
}

function meta(over: Partial<AgentMeta> = {}): AgentMeta {
  return {
    schemaVersion: 1,
    enabled: true,
    disabledAt: null,
    disabledReason: null,
    failureStreak: 0,
    labels: [],
    publishedVersion: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** A repo fake over an id → spec map; ids sort like AgentRepo.listIds(). */
function fakeRepo(specs: Record<string, AgentSpecV2>, metas: Record<string, AgentMeta> = {}): AgentRepo {
  return {
    listIds: () => Object.keys(specs).sort((a, b) => a.localeCompare(b)),
    readSpec: async (id: string) => specs[id],
    readMeta: async (id: string) => metas[id] ?? meta(),
  } as unknown as AgentRepo;
}

function fakeVersions(latest: Record<string, number> = {}): VersionStore {
  return {
    latest: async (id: string) =>
      latest[id] === undefined ? undefined : ({ version: latest[id] } as never),
  } as unknown as VersionStore;
}

function fakeCatalog(over: Partial<CatalogService> = {}): CatalogService {
  return {
    listModels: () => [],
    listTools: () => [],
    listGuardrails: () => [],
    listTriggerTypes: () => [],
    listSkills: async () => [],
    listKits: async () => [],
    listRegistryMcpServers: async () => [],
    ...over,
  };
}

function fakeDeps(over: Partial<AuthorToolDeps> = {}): AuthorToolDeps {
  return {
    workspace: async () => ({ repo: fakeRepo({}), versions: fakeVersions() }) as WorkspaceContext,
    catalog: fakeCatalog(),
    templates: { list: async () => [] },
    probeMcp: async () => ({ ok: true, tools: [] }),
    docsDir: '/nonexistent-docs',
    reviewDraft: async () => ({ pass: true }),
    requirements: async () => [],
    ...over,
  };
}

type Tool = ReturnType<typeof buildAuthorTools>[number];

/** The call name a ToolDescriptor carries (`defineTool` results), else its display name. */
function nameOf(tool: Tool): string {
  return (tool as { name?: string }).name ?? tool.displayName;
}

function tools(deps: AuthorToolDeps): Map<string, Tool> {
  return new Map(buildAuthorTools(TURN, deps).map((tool) => [nameOf(tool), tool]));
}

async function call(tool: Tool, args: Record<string, unknown>): Promise<unknown> {
  return tool.execute?.(args as never, { toolCallId: 'call-1' } as never);
}

function failure(value: unknown): AuthorToolFailure {
  expect(value).toMatchObject({ ok: false });
  return value as AuthorToolFailure;
}

describe('buildAuthorTools', () => {
  it('returns the 15 tools sorted by name, every one in AUTHOR_TOOL_NAMES', () => {
    const built = buildAuthorTools(TURN, fakeDeps());
    const names = built.map(nameOf);
    expect(names).toHaveLength(15);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    for (const name of names) {
      expect(AUTHOR_TOOL_NAMES as readonly string[]).toContain(name);
    }
    expect(AUTHOR_TOOL_FACTORIES).toHaveLength(15);
  });

  it('builds the same list for different turns (the tool surface never changes mid-session)', () => {
    const a = buildAuthorTools(TURN, fakeDeps()).map(nameOf);
    const b = buildAuthorTools({ ...TURN, sessionId: 'other' }, fakeDeps()).map(nameOf);
    expect(a).toEqual(b);
  });
});

describe('getCurrentSpec', () => {
  it('returns the working copy spec, meta summary, latestVersion and specHash', async () => {
    const workspace = {
      repo: fakeRepo(
        { 'support-triage': spec({ name: 'Support triage', description: 'triages mail' }) },
        { 'support-triage': meta({ enabled: false, labels: ['mail'], publishedVersion: 2 }) }
      ),
      versions: fakeVersions({ 'support-triage': 3 }),
    } as WorkspaceContext;
    const result = (await call(tools(fakeDeps({ workspace: async () => workspace })).get('getCurrentSpec')!, {
      agentId: 'support-triage',
    })) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.agentId).toBe('support-triage');
    expect((result.spec as AgentSpecV2).name).toBe('Support triage');
    expect(result.meta).toEqual({ enabled: false, labels: ['mail'], publishedVersion: 2 });
    expect(result.latestVersion).toBe(3);
    expect(result.specHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('AGENT_NOT_FOUND on an unknown id carries all four strings', async () => {
    const result = failure(await call(tools(fakeDeps()).get('getCurrentSpec')!, { agentId: 'nope' }));
    expect(result.code).toBe('AGENT_NOT_FOUND');
    expect(result.error).toBe('No agent with id "nope".');
    expect(result.userMessage).toBe("That agent doesn't exist.");
    expect(result.next).toBe('Call listAgents and copy an id from it.');
  });
});

describe('listAgents', () => {
  const workspace = {
    repo: fakeRepo(
      {
        'a-one': spec({ name: 'Alpha', description: 'first' }),
        'b-two': spec({ name: 'Bravo', description: 'second' }),
        'c-three': spec({ name: 'Charlie', description: 'third' }),
      },
      { 'b-two': meta({ enabled: false, labels: ['ops'] }) }
    ),
    versions: fakeVersions(),
  } as WorkspaceContext;

  it('lists { id, name, description, enabled, model, labels } per agent', async () => {
    const result = (await call(tools(fakeDeps({ workspace: async () => workspace })).get('listAgents')!, {})) as {
      items: Record<string, unknown>[];
      total: number;
    };
    expect(result.total).toBe(3);
    expect(result.items[0]).toEqual({
      id: 'a-one',
      name: 'Alpha',
      description: 'first',
      enabled: true,
      model: 'mock/mock-1',
      labels: [],
    });
    expect(result.items[1]).toMatchObject({ id: 'b-two', enabled: false, labels: ['ops'] });
  });

  it('pages: limit 2 page 2 returns the last item with hasMore false', async () => {
    const result = (await call(tools(fakeDeps({ workspace: async () => workspace })).get('listAgents')!, {
      limit: 2,
      page: 2,
    })) as { items: { id: string }[]; total: number; page: number; hasMore: boolean };
    expect(result.items.map((item) => item.id)).toEqual(['c-three']);
    expect(result).toMatchObject({ total: 3, page: 2, hasMore: false });
  });

  it('query matches id, name and description case-insensitively', async () => {
    const result = (await call(tools(fakeDeps({ workspace: async () => workspace })).get('listAgents')!, {
      query: 'SECOND',
    })) as { items: { id: string }[] };
    expect(result.items.map((item) => item.id)).toEqual(['b-two']);
  });
});

describe('listModels', () => {
  const models = [
    { id: 'anthropic/claude-sonnet-5-5', modelId: 'claude-sonnet-5-5', provider: 'anthropic', contextWindow: 200000, capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true, hostedTools: [] }, available: true, inputCostPerMTok: 3, outputCostPerMTok: 15 },
    { id: 'openai/gpt-4o', modelId: 'gpt-4o', provider: 'openai', contextWindow: 128000, capabilities: { tools: true, vision: true, reasoning: false, structuredOutput: true, hostedTools: [] }, available: false },
  ] as CatalogModel[];

  it('lists models projected to the ticket shape and honours the provider filter', async () => {
    let asked: string | undefined;
    const catalog = fakeCatalog({
      listModels: (provider) => {
        asked = provider;
        return provider === undefined ? models : models.filter((model) => model.provider === provider);
      },
    });
    const result = (await call(tools(fakeDeps({ catalog })).get('listModels')!, { provider: 'anthropic' })) as {
      items: Record<string, unknown>[];
      total: number;
    };
    expect(asked).toBe('anthropic');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      id: 'anthropic/claude-sonnet-5-5',
      provider: 'anthropic',
      contextWindow: 200000,
      capabilities: models[0].capabilities,
      available: true,
      inputCostPerMTok: 3,
      outputCostPerMTok: 15,
    });
  });
});

describe('listTools', () => {
  const catalogTools = [
    { name: 'web_fetch', description: 'Fetch a URL', inputJsonSchema: { type: 'object' }, needsCredentials: [], mutating: false, optionsJsonSchema: null, toolNames: ['web_fetch'] },
    { name: 'http_request', description: 'Make an HTTP request', inputJsonSchema: { type: 'object' }, needsCredentials: [], mutating: true, optionsJsonSchema: null, toolNames: ['http_request'] },
  ] as CatalogTool[];

  it('lists tools without inputJsonSchema by default', async () => {
    const catalog = fakeCatalog({ listTools: () => catalogTools });
    const result = (await call(tools(fakeDeps({ catalog })).get('listTools')!, {})) as {
      items: Record<string, unknown>[];
      unknownNames: string[];
    };
    expect(result.items[0]).toEqual({ name: 'web_fetch', description: 'Fetch a URL', needsCredentials: [], mutating: false });
    expect(result.items[0]).not.toHaveProperty('inputJsonSchema');
    expect(result.unknownNames).toEqual([]);
  });

  it('returns inputJsonSchema for named tools and lists unknown names', async () => {
    const catalog = fakeCatalog({ listTools: () => catalogTools });
    const result = (await call(tools(fakeDeps({ catalog })).get('listTools')!, {
      names: ['http_request', 'not_a_tool'],
    })) as { items: Record<string, unknown>[]; unknownNames: string[] };
    expect(result.items[1]).toMatchObject({ name: 'http_request', inputJsonSchema: { type: 'object' } });
    expect(result.items[0]).not.toHaveProperty('inputJsonSchema');
    expect(result.unknownNames).toEqual(['not_a_tool']);
  });
});

describe('listGuardrails / listTriggerTypes / listSkills / listKits / listTemplates', () => {
  it('listGuardrails projects { name, description, on, optionsJsonSchema }', async () => {
    const catalog = fakeCatalog({
      listGuardrails: () =>
        [
          { name: 'pii', description: 'Finds personal data', on: ['input', 'output'], optionsJsonSchema: { type: 'object' }, canRewrite: true, canRunInParallel: true },
        ] as CatalogGuardrail[],
    });
    const result = (await call(tools(fakeDeps({ catalog })).get('listGuardrails')!, {})) as { items: Record<string, unknown>[] };
    expect(result.items).toEqual([{ name: 'pii', description: 'Finds personal data', on: ['input', 'output'], optionsJsonSchema: { type: 'object' } }]);
  });

  it('listTriggerTypes projects { type, description, fieldsJsonSchema, runsUnder }', async () => {
    const catalog = fakeCatalog({
      listTriggerTypes: () =>
        [
          { type: 'cron', title: 'Schedule', description: 'Runs on a cron expression', fieldsJsonSchema: { type: 'object' }, runsUnder: ['dev', 'studio'] },
        ] as CatalogTriggerType[],
    });
    const result = (await call(tools(fakeDeps({ catalog })).get('listTriggerTypes')!, {})) as { items: Record<string, unknown>[] };
    expect(result.items).toEqual([{ type: 'cron', description: 'Runs on a cron expression', fieldsJsonSchema: { type: 'object' }, runsUnder: ['dev', 'studio'] }]);
  });

  it('listSkills and listKits return the catalog rows', async () => {
    const skills: CatalogSkill[] = [{ name: 'changelog', description: 'Write CHANGELOG entries', ref: { registry: 'changelog' } }];
    const kits: CatalogKit[] = [{ name: 'coding-kit', description: 'A coding harness' }];
    const catalog = fakeCatalog({ listSkills: async () => skills, listKits: async () => kits });
    const toolMap = tools(fakeDeps({ catalog }));
    expect(((await call(toolMap.get('listSkills')!, {})) as { items: CatalogSkill[] }).items).toEqual(skills);
    expect(((await call(toolMap.get('listKits')!, {})) as { items: CatalogKit[] }).items).toEqual(kits);
  });

  it('listTemplates returns TemplateSummary rows and queries title', async () => {
    const summaries: TemplateSummary[] = [
      { id: 'triage', title: 'Inbox triage', description: 'sorts mail', category: 'productivity', tags: ['mail'], requires: [] },
      { id: 'coder', title: 'Coding agent', description: 'writes code', category: 'dev', tags: [], requires: ['provider_key'] },
    ];
    const templates = { list: async () => summaries };
    const result = (await call(tools(fakeDeps({ templates })).get('listTemplates')!, { query: 'coding' })) as {
      items: TemplateSummary[];
      total: number;
    };
    expect(result.items).toEqual([summaries[1]]);
  });
});

describe('listMcpServers', () => {
  const withMcp = spec({
    mcpServers: {
      fs: { command: 'npx', args: ['-y', 'fs-server'], env: { API_KEY: { secret: 'fs_key' }, PLAIN: 'v' } },
      remote: { url: 'https://mcp.example.com/sse', headers: { Authorization: { env: 'TOKEN' } } },
    },
  });

  it('lists agent-configured servers with key names only, never env or header values', async () => {
    const workspace = {
      repo: fakeRepo({ 'a-one': withMcp, 'b-two': spec({ mcpServers: { fs: { command: 'npx', args: ['-y', 'fs-server'] } } }) }),
      versions: fakeVersions(),
    } as WorkspaceContext;
    const result = (await call(tools(fakeDeps({ workspace: async () => workspace })).get('listMcpServers')!, {})) as {
      items: Record<string, unknown>[];
      total: number;
    };
    expect(result.total).toBe(2);
    const fsRow = result.items.find((item) => item.key === 'fs')!;
    // Same key + command across two agents dedupes into one row with both users.
    expect(fsRow).toMatchObject({ key: 'fs', transport: 'stdio', command: 'npx', source: 'agent' });
    expect(fsRow.usedBy).toEqual(['a-one', 'b-two']);
    expect(fsRow.envKeys).toEqual(['API_KEY', 'PLAIN']);
    const remote = result.items.find((item) => item.key === 'remote')!;
    expect(remote).toMatchObject({ key: 'remote', transport: 'http', url: 'https://mcp.example.com/sse', headersKeys: ['Authorization'] });
    // No secret or env values anywhere in the output.
    const text = JSON.stringify(result);
    expect(text).not.toContain('fs_key');
    expect(text).not.toContain('TOKEN');
    expect(text).not.toContain('"v"');
  });

  it('adds registry entries and dedupes a registry row the workspace already uses', async () => {
    const workspace = { repo: fakeRepo({ 'a-one': withMcp }), versions: fakeVersions() } as WorkspaceContext;
    const catalog = fakeCatalog({
      listRegistryMcpServers: async () => [
        { key: 'fs', command: 'npx', url: undefined },
        { key: 'gh', url: 'https://api.githubcopilot.com/mcp/' },
      ],
    });
    const result = (await call(tools(fakeDeps({ workspace: async () => workspace, catalog })).get('listMcpServers')!, {})) as {
      items: Record<string, unknown>[];
    };
    const gh = result.items.find((item) => item.key === 'gh')!;
    expect(gh).toMatchObject({ transport: 'http', url: 'https://api.githubcopilot.com/mcp/', usedBy: [], source: 'registry' });
    // 'fs' stays a single 'agent' row - the registry duplicate merges in.
    expect(result.items.filter((item) => item.key === 'fs')).toHaveLength(1);
  });
});

describe('probeMcpServer', () => {
  it('returns the probed tool list', async () => {
    let probed: McpServerSpecV2 | undefined;
    const deps = fakeDeps({
      probeMcp: async (server) => {
        probed = server;
        return { ok: true, tools: [{ name: 'search', description: 'search things' }] };
      },
    });
    const server = { command: 'npx', args: ['-y', 'mcp-server'] };
    const result = (await call(tools(deps).get('probeMcpServer')!, { server })) as { ok: true; tools: { name: string }[] };
    expect(result).toEqual({ ok: true, tools: [{ name: 'search', description: 'search things' }] });
    expect(probed).toEqual(server);
  });

  it('maps a probe failure to MCP_PROBE_FAILED with model and user copy', async () => {
    const deps = fakeDeps({ probeMcp: async () => ({ ok: false, error: 'spawn npx ENOENT' }) });
    const result = failure(await call(tools(deps).get('probeMcpServer')!, { server: { command: 'npx' } }));
    expect(result.code).toBe('MCP_PROBE_FAILED');
    expect(result.error).toBe('The server did not answer: spawn npx ENOENT.');
    expect(result.userMessage).toBe('Studio could not reach that MCP server.');
    expect(result.next).toBe('Check the command or URL and its secrets, then try again, or ask the user.');
  });

  it('maps a probe timeout to TIMEOUT', async () => {
    const deps = fakeDeps({ probeMcp: async () => ({ ok: false, error: 'timed out', timedOut: true }) });
    const result = failure(await call(tools(deps).get('probeMcpServer')!, { server: { url: 'http://127.0.0.1:1/mcp' } }));
    expect(result.code).toBe('TIMEOUT');
    expect(result.error).toBe('The server did not answer within 10 seconds.');
    expect(result.userMessage).toBe('The MCP server took too long to answer.');
  });
});

describe('openPage', () => {
  it('accepts Studio routes', async () => {
    const tool = tools(fakeDeps()).get('openPage')!;
    for (const path of ['/agents/support-triage/canvas', '/templates', '/settings', '/evals']) {
      expect(await call(tool, { path })).toEqual({ ok: true, path });
    }
  });

  it('rejects non-Studio and traversal paths with INVALID_INPUT', async () => {
    const tool = tools(fakeDeps()).get('openPage')!;
    for (const path of ['/agents/../secrets', 'https://evil.example/', '/agents//x', '/unknown', '/agents with spaces']) {
      const result = failure(await call(tool, { path }));
      expect(result.code).toBe('INVALID_INPUT');
      expect(result.error).toBe(`"${path}" is not a Studio page.`);
      expect(result.userMessage).toBe("That page doesn't exist in Studio.");
      expect(result.next).toBe('Use a path like /agents/<id>/canvas.');
    }
  });
});

describe('read-tool failure safety', () => {
  it('a thrown dependency error becomes UNAVAILABLE, never a throw', async () => {
    const deps = fakeDeps({ workspace: async () => Promise.reject(new Error('disk gone')) });
    const result = failure(await call(tools(deps).get('listAgents')!, {}));
    expect(result.code).toBe('UNAVAILABLE');
    expect(result.error).toBe('listAgents failed: disk gone.');
    expect(result.userMessage).toBe("Studio couldn't read that just now.");
  });
});
