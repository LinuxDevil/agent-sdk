/**
 * computeRequirements (author/requirements.ts): the readiness list of a
 * spec v2 - provider key, models, named secrets and env vars, MCP servers,
 * builtin/registry/file tools - each `ok`, `missing` or `unknown` with a
 * fix where one exists. Never throws, never blocks a save.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSpecV2 } from 'lousho';
import { computeRequirements, requirementDeps, type RequirementDeps } from '../requirements';
import type { Requirement } from '../../../shared/authorWire';
import type { SecretsStore } from '../../secretsStore';

const MODEL_IDS = new Set([
  'anthropic/claude-x',
  'openai/gpt-1',
  'openrouter/vendormodel',
  'google/gemini-x',
  'ollama/llama3',
  'mock/mock-1',
  'pi/openrouter/x',
]);

const BUILTIN_TOOLS = [
  { name: 'web_fetch', needsCredentials: [] as string[] },
  { name: 'credentialed_tool', needsCredentials: ['CRED_KEY', 'CRED_URL'] },
];

function spec(extra: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return {
    version: 2,
    name: 'test agent',
    model: 'mock/mock-1',
    instructions: 'Do things.',
    ...extra,
  };
}

/** Deps with every check failing by default; tests override the seam they exercise. */
function deps(overrides: Partial<RequirementDeps> = {}): RequirementDeps {
  return {
    secrets: { getKey: () => undefined, hasNamed: () => false },
    env: {},
    catalog: {
      modelIds: async () => MODEL_IDS,
      builtinTools: async () => BUILTIN_TOOLS,
    },
    fileExists: () => false,
    ...overrides,
  };
}

const byId = (rows: Requirement[]) => new Map(rows.map((row) => [row.id, row]));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computeRequirements', () => {
  describe('provider rows', () => {
    it('anthropic model, no stored key and no env -> one missing provider row with the settings fix', async () => {
      const rows = await computeRequirements(spec({ model: 'anthropic/claude-x' }), deps());
      expect(byId(rows).get('provider:anthropic')).toEqual({
        id: 'provider:anthropic',
        kind: 'provider_key',
        status: 'missing',
        label: 'Anthropic API key',
        fix: { action: 'open_settings', target: '/settings' },
      });
    });

    it('anthropic is ok with a stored key, and openai is ok with its env var', async () => {
      const rows = await computeRequirements(
        spec({ model: 'anthropic/claude-x', fallbackModels: ['openai/gpt-1'] }),
        deps({
          secrets: { getKey: (p) => (p === 'anthropic' ? 'sk-stored' : undefined), hasNamed: () => false },
          env: { OPENAI_API_KEY: 'sk-env' },
        })
      );
      const map = byId(rows);
      expect(map.get('provider:anthropic')?.status).toBe('ok');
      expect(map.get('provider:openai')).toMatchObject({
        kind: 'provider_key',
        status: 'ok',
        label: 'OpenAI API key',
        fix: { action: 'open_settings', target: '/settings' },
      });
    });

    it('openai falls back to OPENAI_API_KEY and anthropic to ANTHROPIC_API_KEY when no key is stored', async () => {
      const rows = await computeRequirements(
        spec({ model: 'openai/gpt-1', fallbackModels: ['anthropic/claude-x'] }),
        deps({ env: { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' } })
      );
      expect(byId(rows).get('provider:openai')?.status).toBe('ok');
      expect(byId(rows).get('provider:anthropic')?.status).toBe('ok');
    });

    it('openrouter and google read their env vars (missing and ok)', async () => {
      const missing = await computeRequirements(spec({ model: 'openrouter/vendormodel' }), deps());
      expect(byId(missing).get('provider:openrouter')).toEqual({
        id: 'provider:openrouter',
        kind: 'provider_key',
        status: 'missing',
        label: 'OpenRouter API key',
        fix: { action: 'open_settings', target: '/settings' },
      });
      const googleMissing = await computeRequirements(spec({ model: 'google/gemini-x' }), deps());
      expect(byId(googleMissing).get('provider:google')).toMatchObject({ status: 'missing', label: 'Google API key' });

      const ok = await computeRequirements(
        spec({ model: 'openrouter/vendormodel', fallbackModels: ['google/gemini-x'] }),
        deps({ env: { OPENROUTER_API_KEY: 'k', GOOGLE_GENERATIVE_AI_API_KEY: 'k' } })
      );
      expect(byId(ok).get('provider:openrouter')?.status).toBe('ok');
      expect(byId(ok).get('provider:google')?.status).toBe('ok');
    });

    it('ollama and mock providers produce no row', async () => {
      const rows = await computeRequirements(spec({ model: 'mock/mock-1', fallbackModels: ['ollama/llama3'] }), deps());
      expect(rows.some((row) => row.id === 'provider:ollama' || row.id === 'provider:mock')).toBe(false);
    });

    it('any other provider is an unknown row with no fix', async () => {
      const rows = await computeRequirements(spec({ model: 'pi/openrouter/x' }), deps());
      expect(byId(rows).get('provider:pi')).toEqual({
        id: 'provider:pi',
        kind: 'provider_key',
        status: 'unknown',
        label: 'pi provider',
      });
    });

    it('the provider of every fallback model is checked too', async () => {
      const rows = await computeRequirements(
        spec({ model: 'mock/mock-1', fallbackModels: ['anthropic/claude-x', 'openrouter/vendormodel'] }),
        deps()
      );
      const map = byId(rows);
      expect(map.get('provider:anthropic')?.status).toBe('missing');
      expect(map.get('provider:openrouter')?.status).toBe('missing');
      expect(map.has('provider:mock')).toBe(false);
    });
  });

  describe('model rows', () => {
    it('a model absent from the catalog is an unknown row', async () => {
      const rows = await computeRequirements(spec({ model: 'anthropic/not-real' }), deps());
      expect(byId(rows).get('model:anthropic/not-real')).toEqual({
        id: 'model:anthropic/not-real',
        kind: 'model',
        status: 'unknown',
        label: 'Model anthropic/not-real is not in the catalog',
      });
    });

    it('a fallback model absent from the catalog is an unknown row; catalog models get none', async () => {
      const rows = await computeRequirements(
        spec({ model: 'anthropic/claude-x', fallbackModels: ['openai/gpt-1', 'openai/gpt-9'] }),
        deps()
      );
      const map = byId(rows);
      expect(map.has('model:anthropic/claude-x')).toBe(false);
      expect(map.has('model:openai/gpt-1')).toBe(false);
      expect(map.get('model:openai/gpt-9')?.status).toBe('unknown');
    });
  });

  describe('secret and env ref rows (deep walk)', () => {
    it('a { secret } ref nested in mcpServers.<key>.env is found once even when referenced twice', async () => {
      const rows = await computeRequirements(
        spec({
          mcpServers: {
            gh: {
              command: 'gh-mcp',
              env: {
                GITHUB_TOKEN: { secret: 'GITHUB_TOKEN' },
                OTHER: { secret: 'GITHUB_TOKEN' },
              },
            },
          },
        }),
        deps()
      );
      const secretRows = rows.filter((row) => row.id === 'secret:GITHUB_TOKEN');
      expect(secretRows).toEqual([
        {
          id: 'secret:GITHUB_TOKEN',
          kind: 'secret',
          status: 'missing',
          label: 'Secret GITHUB_TOKEN',
          fix: { action: 'add_secret', target: 'GITHUB_TOKEN' },
        },
      ]);
    });

    it('a { secret } ref is ok when the named secret is stored', async () => {
      const rows = await computeRequirements(
        spec({
          mcpServers: { m: { command: 'm', env: { T: { secret: 'MY_KEY' } } } },
        }),
        deps({ secrets: { getKey: () => undefined, hasNamed: (name) => name === 'MY_KEY' } })
      );
      expect(byId(rows).get('secret:MY_KEY')?.status).toBe('ok');
    });

    it('a { env } ref is ok when the variable is set, missing when unset, and has no fix', async () => {
      const missing = await computeRequirements(
        spec({ mcpServers: { gh: { command: 'gh-mcp', env: { T: { env: 'GH_TOKEN' } } } } }),
        deps()
      );
      expect(byId(missing).get('env:GH_TOKEN')).toEqual({
        id: 'env:GH_TOKEN',
        kind: 'secret',
        status: 'missing',
        label: 'Environment variable GH_TOKEN',
      });
      const ok = await computeRequirements(
        spec({ mcpServers: { gh: { command: 'gh-mcp', env: { T: { env: 'GH_TOKEN' } } } } }),
        deps({ env: { GH_TOKEN: 'x' } })
      );
      expect(byId(ok).get('env:GH_TOKEN')?.status).toBe('ok');
    });

    it('{ env } and { secret } refs of the same name are separate rows', async () => {
      const rows = await computeRequirements(
        spec({
          mcpServers: { a: { command: 'a', env: { A: { env: 'TOKEN' }, B: { secret: 'TOKEN' } } } },
        }),
        deps()
      );
      expect(byId(rows).has('env:TOKEN')).toBe(true);
      expect(byId(rows).has('secret:TOKEN')).toBe(true);
    });

    it('refs inside tool options, triggers and inline subagent specs are found; instructions is not walked', async () => {
      const rows = await computeRequirements(
        spec({
          instructions: { file: 'prompts/main.md' },
          tools: [{ openapi: { url: 'https://api.example.com/spec.json', bearerToken: { secret: 'API_KEY' } } }],
          triggers: [{ id: 't1', type: 'webhook', path: '/hook', secret: { secret: 'HOOK_SECRET' }, promptTemplate: 'x' }],
          subagents: {
            sub: {
              inline: {
                name: 'sub',
                description: 'a sub',
                model: 'mock/mock-1',
                instructions: 'sub prompt',
                mcpServers: { m: { command: 'm', env: { K: { secret: 'SUB_SECRET' } } } },
              },
            },
          },
        }),
        deps()
      );
      const map = byId(rows);
      expect(map.has('secret:API_KEY')).toBe(true);
      expect(map.has('secret:HOOK_SECRET')).toBe(true);
      expect(map.has('secret:SUB_SECRET')).toBe(true);
    });
  });

  describe('mcp rows', () => {
    it('each mcpServers key is an unknown row with the probe fix', async () => {
      const rows = await computeRequirements(
        spec({
          mcpServers: {
            gh: { command: 'gh-mcp' },
            remote: { url: 'https://mcp.example.com' },
          },
        }),
        deps()
      );
      const map = byId(rows);
      expect(map.get('mcp:gh')).toEqual({
        id: 'mcp:gh',
        kind: 'mcp',
        status: 'unknown',
        label: 'MCP server gh',
        fix: { action: 'probe', target: 'gh' },
      });
      expect(map.get('mcp:remote')).toMatchObject({ status: 'unknown', fix: { action: 'probe', target: 'remote' } });
    });
  });

  describe('tool rows', () => {
    it('a builtin absent from the catalog is a missing row', async () => {
      const rows = await computeRequirements(spec({ tools: [{ builtin: 'no_such_tool' }] }), deps());
      expect(byId(rows).get('tool:no_such_tool')).toEqual({
        id: 'tool:no_such_tool',
        kind: 'tool',
        status: 'missing',
        label: 'Tool no_such_tool is not available',
      });
    });

    it('a catalog builtin with no credentials produces no row', async () => {
      const rows = await computeRequirements(spec({ tools: [{ builtin: 'web_fetch' }] }), deps());
      expect(rows.filter((row) => row.id.startsWith('tool:'))).toEqual([]);
    });

    it('a builtin with needsCredentials gets one row per credential, env or named secret satisfying it', async () => {
      const rows = await computeRequirements(spec({ tools: [{ builtin: 'credentialed_tool' }] }), deps());
      const map = byId(rows);
      expect(map.get('tool:credentialed_tool:CRED_KEY')).toEqual({
        id: 'tool:credentialed_tool:CRED_KEY',
        kind: 'tool',
        status: 'missing',
        label: 'CRED_KEY for credentialed_tool',
        fix: { action: 'add_secret', target: 'CRED_KEY' },
      });
      expect(map.get('tool:credentialed_tool:CRED_URL')?.status).toBe('missing');

      const satisfied = await computeRequirements(
        spec({ tools: [{ builtin: 'credentialed_tool' }] }),
        deps({
          env: { CRED_KEY: 'v' },
          secrets: { getKey: () => undefined, hasNamed: (n) => n === 'CRED_URL' },
        })
      );
      expect(byId(satisfied).get('tool:credentialed_tool:CRED_KEY')?.status).toBe('ok');
      expect(byId(satisfied).get('tool:credentialed_tool:CRED_URL')?.status).toBe('ok');
    });

    it('a { registry } tool is an unknown row', async () => {
      const rows = await computeRequirements(spec({ tools: [{ registry: 'github-issues' }] }), deps());
      expect(byId(rows).get('registry:github-issues')).toEqual({
        id: 'registry:github-issues',
        kind: 'tool',
        status: 'unknown',
        label: 'Registry tool github-issues',
      });
    });
  });

  describe('file rows', () => {
    it('tools[i].file, hooks[i].file and skills[i].dir are file rows, ok when the file exists', async () => {
      const rows = await computeRequirements(
        spec({
          tools: [{ file: 'tools/mine.ts' }],
          hooks: [{ id: 'h1', file: 'hooks/mine.ts' }],
          skills: [{ dir: 'skills/mine' }],
        }),
        deps({ fileExists: (rel) => rel === 'tools/mine.ts' })
      );
      const map = byId(rows);
      expect(map.get('file:tools/mine.ts')).toEqual({
        id: 'file:tools/mine.ts',
        kind: 'tool',
        status: 'ok',
        label: 'File tools/mine.ts',
      });
      expect(map.get('file:hooks/mine.ts')?.status).toBe('missing');
      expect(map.get('file:skills/mine')?.status).toBe('missing');
    });
  });

  describe('sorting, dedupe and the never-throw contract', () => {
    it('rows sort missing first, then unknown, then ok; ids sort inside a status', async () => {
      const rows = await computeRequirements(
        spec({
          model: 'google/gemini-x',
          tools: [{ builtin: 'no_such_tool' }, { registry: 'zzz' }],
          mcpServers: { aaa: { command: 'a', env: { V: { env: 'SET_VAR' } } } },
        }),
        deps({ env: { SET_VAR: 'x', GOOGLE_GENERATIVE_AI_API_KEY: 'k' } })
      );
      const rank = { missing: 0, unknown: 1, ok: 2 } as const;
      const statuses = rows.map((row) => row.status);
      for (let i = 1; i < statuses.length; i++) {
        expect(rank[statuses[i]]).toBeGreaterThanOrEqual(rank[statuses[i - 1]]);
        if (statuses[i] === statuses[i - 1]) {
          expect(rows[i].id >= rows[i - 1].id).toBe(true);
        }
      }
      expect(rows[0]).toMatchObject({ id: 'tool:no_such_tool', status: 'missing' });
      expect(statuses.at(-1)).toBe('ok');
    });

    it('duplicate sources dedupe by id (same secret twice, model and fallback same provider)', async () => {
      const rows = await computeRequirements(
        spec({
          model: 'anthropic/claude-x',
          fallbackModels: ['anthropic/claude-x'],
          mcpServers: {
            a: { command: 'a', env: { A: { secret: 'S' }, B: { secret: 'S' } } },
          },
        }),
        deps()
      );
      expect(rows.filter((row) => row.id === 'provider:anthropic')).toHaveLength(1);
      expect(rows.filter((row) => row.id === 'secret:S')).toHaveLength(1);
      expect(rows.filter((row) => row.id === 'model:anthropic/claude-x')).toHaveLength(0);
    });

    it('an exception inside a helper logs one line and returns [] instead of throwing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rows = await computeRequirements(
        spec(),
        deps({
          catalog: {
            modelIds: async () => MODEL_IDS,
            builtinTools: async () => {
              throw new Error('catalog broke');
            },
          },
        })
      );
      expect(rows).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('catalog broke'));
    });
  });
});

describe('requirementDeps.fileExists (prod dep)', () => {
  it('resolves under the workspace root and never stats outside it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa13-files-'));
    try {
      fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(root, 'tools', 'mine.ts'), 'export {};\n');
      const secretsStub = { getKey: () => undefined, getSecret: () => undefined } as unknown as SecretsStore;
      const d = requirementDeps(root, secretsStub);
      expect(d.fileExists('tools/mine.ts')).toBe(true);
      // Traversal and absolute paths are reported missing without leaving root.
      expect(d.fileExists('../../etc/passwd')).toBe(false);
      expect(d.fileExists('../../../outside.txt')).toBe(false);
      expect(d.fileExists(path.resolve(root, '..', 'outside.txt'))).toBe(false);
      expect(d.fileExists('tools/missing.ts')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
