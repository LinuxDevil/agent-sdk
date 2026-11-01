import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgent, type SimpleAgent } from '../../createAgent';
import type { TraceExporter } from '../../execution/tracing';
import { LLMProviderRegistry } from '../../providers/llm';
import { createMockProvider } from '../../providers/mock';
import { OpenRouterProvider } from '../../providers/OpenRouterProvider';
import type { AgentStore } from '../../storage/agentStore';
import type { SpecHost } from './host';
import { compileSpec, specV2ToAgent, type SpecAgentV2 } from './specToAgent';
import type { AgentSpecV2 } from './types';

const DEFAULT_RESPONSES = ['deterministic response one', 'deterministic response two'];

/** The scripted replies the next 'mock' provider is created with; tests set it before building an agent. */
let responses = [...DEFAULT_RESPONSES];

beforeAll(() => {
  // The factory spreads the caller's config so the 'mock/<model>' half lands on defaultModel.
  LLMProviderRegistry.register('mock', (config) => createMockProvider({ ...config, responses }));
});

afterEach(() => {
  responses = [...DEFAULT_RESPONSES];
  vi.unstubAllEnvs();
});

function spec(overrides: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/m', instructions: 'You are a test agent.', ...overrides };
}

function host(overrides: Partial<SpecHost> = {}): SpecHost {
  return { baseDir: mkdtempSync(path.join(tmpdir(), 'lousho-spec-v2-')), ...overrides };
}

describe('specV2ToAgent', () => {
  it('builds a running agent from a minimal spec', async () => {
    const input = spec();
    const agent = await specV2ToAgent(input, host());
    const result = await agent.send('hi');
    expect(result.text).toBe('deterministic response one');
    expect(agent.spec).toEqual(input);
    expect(agent.mcpServers).toEqual({});
    expect(agent.toolNamesByRef).toEqual([]);
  });

  it('rejects an invalid spec before building anything', async () => {
    await expect(specV2ToAgent({ name: 'a', model: 'mock/m', instructions: 'x' } as AgentSpecV2, host())).rejects.toMatchObject(
      { code: 'LOUSHO_SPEC_INVALID' }
    );
  });

  it('exposes the resolved mcpServers and toolNamesByRef on the agent', async () => {
    const agent = await specV2ToAgent(
      spec({ tools: [{ builtin: 'current_date' }], mcpServers: { docs: { url: 'https://x.test/mcp' } } }),
      host()
    );
    expect(agent.toolNamesByRef).toEqual([['current_date']]);
    expect(agent.mcpServers).toEqual({ docs: { url: 'https://x.test/mcp' } });
  });
});

describe('compileSpec data section', () => {
  it('passes the plain-data keys through to the createAgent config', async () => {
    const input = spec({
      description: 'A spec agent.',
      fallbackModels: ['mock/f1', 'mock/f2'],
      modelSettings: { maxTokens: 64, temperature: 0.2 },
      reasoning: 'low',
      limits: { maxSteps: 7 },
      maxSteps: 9,
      compaction: { thresholdPercent: 0.5 },
      retry: { maxRetries: 4, backoff: { initialMs: 10 } },
      rateLimit: { requestsPerMinute: 12 },
      promptCaching: 'auto',
      toolSearch: { maxResults: 3 },
      codeMode: { timeoutMs: 1000 },
      permissionMode: 'plan',
      approvalTtlMs: 60_000,
      askQuestion: true,
      subagentOptions: { maxConcurrent: 2 },
      maxSubagentDepth: 2,
      maxHandoffs: 4,
    });
    const { config } = await compileSpec(input, host());
    expect(config.name).toBe('a');
    const keys = [
      'description',
      'fallbackModels',
      'modelSettings',
      'reasoning',
      'limits',
      'maxSteps',
      'compaction',
      'retry',
      'rateLimit',
      'promptCaching',
      'toolSearch',
      'codeMode',
      'permissionMode',
      'approvalTtlMs',
      'askQuestion',
      'subagentOptions',
      'maxSubagentDepth',
      'maxHandoffs',
    ] as const;
    const built = config as Record<string, unknown>;
    for (const key of keys) expect(built[key]).toEqual(input[key]);
  });

  it("splits spec.model at the FIRST '/', so 'openrouter/anthropic/x' keeps 'anthropic/x' as the model", async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-dummy');
    const { config } = await compileSpec(spec({ model: 'openrouter/anthropic/claude-sonnet-4-5' }), host());
    expect(config.provider).toBeInstanceOf(OpenRouterProvider);
    expect(config.provider?.defaultModel).toBe('anthropic/claude-sonnet-4-5');
  });

  it("resolves 'mock/<id>' through the registry, like v1", async () => {
    const { config } = await compileSpec(spec({ model: 'mock/spec-model-7' }), host());
    expect(config.provider?.defaultModel).toBe('spec-model-7');
  });

  it('maps promptRef to config.prompt, keeping instructions as the fallback', async () => {
    const { config } = await compileSpec(spec({ promptRef: 'support@prod' }), host());
    expect(config.prompt).toBe('support@prod');
    expect(config.instructions).toBe('You are a test agent.');
  });

  it('reads instructions.file relative to host.baseDir', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-spec-v2-'));
    writeFileSync(path.join(dir, 'main.md'), 'You are file-based.');
    const { config } = await compileSpec(spec({ instructions: { file: 'main.md' } }), host({ baseDir: dir }));
    expect(config.instructions).toBe('You are file-based.');
  });

  it('rejects an empty instructions.file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lousho-spec-v2-'));
    writeFileSync(path.join(dir, 'main.md'), '   \n');
    await expect(compileSpec(spec({ instructions: { file: 'main.md' } }), host({ baseDir: dir }))).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_INVALID',
      field: 'instructions',
    });
  });

  it('appends the first instructionsByFamily tail the model id contains', async () => {
    const { config } = await compileSpec(
      spec({ model: 'mock/claude-x', instructionsByFamily: { claude: 'Claude tail.', mock: 'Mock tail.' } }),
      host()
    );
    expect(config.instructions).toBe('You are a test agent.\nClaude tail.');
  });

  it('sets host.store and host.exporter on the config only when given', async () => {
    const store = { sentinel: 'store' } as unknown as AgentStore;
    const exporter = { sentinel: 'exporter' } as unknown as TraceExporter;
    const withBoth = await compileSpec(spec(), host({ store, exporter }));
    expect(withBoth.config.store).toBe(store);
    expect(withBoth.config.exporter).toBe(exporter);
    const bare = await compileSpec(spec(), host());
    expect(bare.config.store).toBeUndefined();
    expect(bare.config.exporter).toBeUndefined();
  });

  it('keeps spec-only keys (version, model, instructionsByFamily, triggers, flow) off the config', async () => {
    const input = spec({
      instructionsByFamily: { mock: 'tail' },
      triggers: [{ id: 't1', type: 'chat' }] as never,
    });
    const { config } = await compileSpec(input, host());
    const built = config as Record<string, unknown>;
    for (const key of ['version', 'model', 'instructionsByFamily', 'promptRef', 'tools', 'triggers', 'flow', 'evals']) {
      expect(built[key]).toBeUndefined();
    }
  });
});

describe('compileSpec tools section', () => {
  it('merges the tools of every ref into one record and records toolNamesByRef', async () => {
    const { config, toolNamesByRef } = await compileSpec(spec({ tools: [{ builtin: 'current_date' }, { builtin: 'todo' }] }), host());
    expect(Object.keys(config.tools as Record<string, unknown>)).toEqual(['current_date', 'todo_write', 'todo_read']);
    expect(toolNamesByRef).toEqual([['current_date'], ['todo_write', 'todo_read']]);
  });

  it('rejects a tool name two refs produce', async () => {
    await expect(
      compileSpec(spec({ tools: [{ builtin: 'current_date' }, { builtin: 'current_date' }] }), host())
    ).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_INVALID',
      field: 'tools',
      message: expect.stringContaining("tool 'current_date' is produced by tools.0 and tools.1"),
    });
  });

  it('leaves tools unset when the spec has none', async () => {
    const { config, toolNamesByRef } = await compileSpec(spec(), host());
    expect(config.tools).toBeUndefined();
    expect(toolNamesByRef).toEqual([]);
  });
});

describe('compileSpec mcpServers section', () => {
  it('resolves { env } and { secret } refs through the host', async () => {
    const { config, mcpServers } = await compileSpec(
      spec({
        mcpServers: {
          api: { url: 'https://x.test/mcp', headers: { Authorization: { env: 'HDR' }, 'X-Key': { secret: 'tok' } } },
        },
      }),
      host({ env: { HDR: 'v1' }, resolveSecret: (name) => (name === 'tok' ? 's3' : undefined) })
    );
    expect(mcpServers['api']).toEqual({ url: 'https://x.test/mcp', headers: { Authorization: 'v1', 'X-Key': 's3' } });
    expect(config.mcpServers).toEqual(mcpServers);
  });

  it('fails with LOUSHO_SPEC_SECRET_MISSING when a referenced secret is absent', async () => {
    await expect(
      compileSpec(
        spec({ mcpServers: { api: { url: 'https://x.test/mcp', headers: { Authorization: { secret: 'gone' } } } } }),
        host({ resolveSecret: () => undefined })
      )
    ).rejects.toMatchObject({ code: 'LOUSHO_SPEC_SECRET_MISSING' });
  });

  it('leaves mcpServers unset when the spec has none but reports an empty record', async () => {
    const { config, mcpServers } = await compileSpec(spec(), host());
    expect(config.mcpServers).toBeUndefined();
    expect(mcpServers).toEqual({});
  });
});

describe('compileSpec output section', () => {
  it('compiles spec.output so send() validates result.object', async () => {
    responses = ['{"city":"Paris","tempC":21}'];
    const agent = await specV2ToAgent(
      spec({
        output: {
          jsonSchema: {
            type: 'object',
            properties: { city: { type: 'string' }, tempC: { type: 'number' } },
            required: ['city', 'tempC'],
          },
        },
      }),
      host()
    );
    const result = await agent.send('Weather in Paris?');
    expect(result.object).toEqual({ city: 'Paris', tempC: 21 });
  });
});

describe('compileSpec skills section', () => {
  it('compiles an inline skill ref into a Skill', async () => {
    const { config } = await compileSpec(
      spec({ skills: [{ inline: { name: 'changelog', description: 'Write changelogs.', content: '# Changelog\nDo X.' } }] }),
      host()
    );
    expect(config.skills).toHaveLength(1);
    expect(config.skills?.[0]).toMatchObject({ name: 'changelog', description: 'Write changelogs.', content: '# Changelog\nDo X.' });
  });

  it('leaves skills unset when the spec has none', async () => {
    const { config } = await compileSpec(spec(), host());
    expect(config.skills).toBeUndefined();
  });
});

describe('compileSpec memory section', () => {
  it('compiles an in-memory slot into a MemorySlot', async () => {
    const { config } = await compileSpec(
      spec({ memory: [{ name: 'notes', scope: 'session', provider: { type: 'in-memory' } }] }),
      host()
    );
    expect(config.memory).toHaveLength(1);
    expect(config.memory?.[0]).toMatchObject({ name: 'notes' });
  });

  it('wires the JSON-Schema adapter so itemJsonSchema needs no host support', async () => {
    const { config } = await compileSpec(
      spec({
        memory: [
          {
            name: 'facts',
            scope: 'global',
            provider: { type: 'in-memory' },
            itemJsonSchema: { type: 'object', properties: { text: { type: 'string' } } },
            itemKey: 'text',
          },
        ],
      }),
      host()
    );
    expect(config.memory?.[0]?.itemSchema).toBeDefined();
    expect(config.memory?.[0]?.itemKey).toEqual(['text']);
  });

  it('leaves memory unset when the spec has none', async () => {
    const { config } = await compileSpec(spec(), host());
    expect(config.memory).toBeUndefined();
  });
});

describe('compileSpec subagents section', () => {
  it('compiles an inline subagent recursively: its name and description reach the built agent', async () => {
    const { config } = await compileSpec(
      spec({
        subagents: {
          research: { inline: { name: 'researcher', model: 'mock/m', instructions: 'Research things.', description: 'Finds things.' } },
        },
      }),
      host()
    );
    const built = (config.subagents as Record<string, SpecAgentV2>)['research'];
    expect(typeof built.send).toBe('function');
    expect(built.spec.name).toBe('researcher');
    expect(built.spec.description).toBe('Finds things.');
  });

  it('rejects a { ref } subagent on a host without loadAgentRef', async () => {
    await expect(
      compileSpec(spec({ subagents: { helper: { ref: 'agents/helper.yaml' } } }), host())
    ).rejects.toMatchObject({ code: 'LOUSHO_SPEC_UNSUPPORTED' });
  });

  it('leaves subagents unset when the spec has none', async () => {
    const { config } = await compileSpec(spec(), host());
    expect(config.subagents).toBeUndefined();
  });
});

describe('compileSpec handoffs section', () => {
  it('compiles a handoff through the host resolveHandoffAgent', async () => {
    const target = createAgent({ name: 'ext', description: 'External agent.', provider: createMockProvider({ responses }) });
    const { config } = await compileSpec(
      spec({ handoffs: [{ agent: 'ext', description: 'Go external.' }] }),
      host({ resolveHandoffAgent: () => Promise.resolve(target) })
    );
    expect(config.handoffs).toHaveLength(1);
    expect(config.handoffs?.[0]).toMatchObject({ kind: 'handoff', target });
  });

  it('reuses the built subagent when the handoff names one of this spec subagents', async () => {
    const input = spec({
      subagents: {
        helper: { inline: { name: 'helper', model: 'mock/m', instructions: 'Help.', description: 'Helps.' } },
      },
      handoffs: [{ agent: 'helper' }],
    });
    const { config } = await compileSpec(input, host());
    const built = (config.subagents as Record<string, SimpleAgent>)['helper'];
    expect(config.handoffs?.[0]).toMatchObject({ kind: 'handoff', target: built });
  });

  it('rejects a handoff whose target is neither a subagent nor host-resolvable', async () => {
    await expect(compileSpec(spec({ handoffs: [{ agent: 'nobody' }] }), host())).rejects.toMatchObject({
      code: 'LOUSHO_SPEC_UNSUPPORTED',
      field: 'handoffs.0',
    });
  });

  it('leaves handoffs unset when the spec has none', async () => {
    const { config } = await compileSpec(spec(), host());
    expect(config.handoffs).toBeUndefined();
  });
});

describe('compileSpec guardrails section', () => {
  it('compiles entries into AgentGuardrails named by their spec id', async () => {
    const { config } = await compileSpec(
      spec({
        guardrails: [
          { id: 'g1', name: 'max-length', on: 'input', options: { maxChars: 100 } },
          { id: 'g2', name: 'deny-topics', options: { topics: ['weapons'] } },
        ],
      }),
      host()
    );
    expect(config.guardrails?.input).toHaveLength(2);
    expect(config.guardrails?.input?.map((g) => g.name)).toEqual(['g1', 'g2']);
    expect(config.guardrails?.output).toHaveLength(1);
    expect(config.guardrails?.output?.[0]?.name).toBe('g2');
  });
});

describe('compileSpec permissions section', () => {
  it('compiles entries into PermissionRules', async () => {
    const { config } = await compileSpec(
      spec({ permissions: [{ id: 'p1', tool: 'http_*', action: 'ask', reason: 'Network calls need review.' }] }),
      host()
    );
    expect(config.permissions).toHaveLength(1);
    expect(config.permissions?.[0]).toMatchObject({ action: 'ask', reason: 'Network calls need review.' });
  });
});

describe('compileSpec hooks section', () => {
  it('compiles an inline hook through host.inlineHook, named by its id', async () => {
    const seen: unknown[] = [];
    const { config } = await compileSpec(
      spec({ hooks: [{ id: 'h1', inline: { name: 'noop', point: 'preToolCall', code: 'return;' } }] }),
      host({
        inlineHook: (hook) => {
          seen.push(hook);
          return { name: hook.name, preToolCall: () => undefined };
        },
      })
    );
    expect(seen).toEqual([{ id: 'h1', name: 'noop', point: 'preToolCall', code: 'return;' }]);
    expect(config.hooks).toHaveLength(1);
    expect(config.hooks?.[0]).toMatchObject({ name: 'h1' });
    expect(typeof config.hooks?.[0]?.preToolCall).toBe('function');
  });

  it('rejects an inline hook on a host without inlineHook', async () => {
    await expect(
      compileSpec(spec({ hooks: [{ id: 'h1', inline: { name: 'n', point: 'preGenerate', code: 'x();' } }] }), host())
    ).rejects.toMatchObject({ code: 'LOUSHO_SPEC_UNSUPPORTED' });
  });
});

describe('specV2ToAgent with every section', () => {
  it('compiles a spec using skills, memory, subagents, handoffs, guardrails, permissions and hooks', async () => {
    const input = spec({
      skills: [{ inline: { name: 'changelog', description: 'Write changelogs.', content: '# C' } }],
      memory: [{ name: 'notes', scope: 'session', provider: { type: 'in-memory' } }],
      subagents: {
        helper: { inline: { name: 'helper', model: 'mock/m', instructions: 'Help.', description: 'Helps.' } },
      },
      handoffs: [{ agent: 'helper' }],
      guardrails: [{ id: 'g1', name: 'deny-topics', on: 'input', options: { topics: ['weapons'] } }],
      permissions: [{ id: 'p1', tool: '*', action: 'allow' }],
      hooks: [{ id: 'h1', inline: { name: 'noop', point: 'postGenerate', code: 'return;' } }],
    });
    const agent = await specV2ToAgent(input, host({ inlineHook: (hook) => ({ name: hook.name, postGenerate: () => undefined }) }));
    const result = await agent.send('hi');
    expect(result.text).toBe('deterministic response one');
    expect(agent.spec).toEqual(input);
  });
});
