import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TraceExporter } from '../../execution/tracing';
import { LLMProviderRegistry } from '../../providers/llm';
import { createMockProvider } from '../../providers/mock';
import { OpenRouterProvider } from '../../providers/OpenRouterProvider';
import type { AgentStore } from '../../storage/agentStore';
import type { SpecHost } from './host';
import { compileSpec, specV2ToAgent } from './specToAgent';
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
