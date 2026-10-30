import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';
import { agentSpecV2Schema } from './schema';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(tools: unknown) {
  return { ...base, tools };
}

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

describe('spec v2 tools', () => {
  it('accepts every ToolRef form', () => {
    const tools = [
      { builtin: 'web_fetch' },
      { builtin: 'http_request', options: { timeout: 5000 } },
      { hosted: 'web_search', options: { maxUses: 3 } },
      { hub: true },
      { file: 'tools/inbox.ts' },
      { registry: 'github-issues' },
    ];
    const result = agentSpecV2Schema.safeParse(spec(tools));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tools).toEqual(tools);
  });

  it('suggests the builtin a kebab name is a typo of', () => {
    const error = thrown(spec([{ builtin: 'web-fetch' }]));
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('tools.0.builtin');
    expect(error.message).toContain("did you mean 'web_fetch'");
  });

  it('points an integration name written as a builtin at { integration }', () => {
    const error = thrown(spec([{ builtin: 'github' }]));
    expect(error.errors).toHaveProperty('tools.0.builtin');
    expect(error.message).toContain('is an integration');
  });

  it('rejects options for a builtin that takes none', () => {
    const error = thrown(spec([{ builtin: 'current_date', options: {} }]));
    expect(error.errors).toHaveProperty('tools.0.options');
    expect(error.message).toContain("'current_date' takes no options");
  });

  it("rejects options the builtin's own schema does not know", () => {
    const error = thrown(spec([{ builtin: 'web_fetch', options: { transport: 1 } }]));
    expect(error.errors).toHaveProperty('tools.0.options');
  });

  it('requires exactly one tool-ref kind key', () => {
    for (const tools of [[{ builtin: 'x', file: 'a.ts' }], [{}], ['web_fetch']]) {
      const error = thrown(spec(tools));
      expect(error.errors).toHaveProperty('tools.0');
      expect(error.message).toContain('exactly one of builtin, registry, file, integration, openapi, hosted, hub');
    }
  });

  it('requires file_search options (vectorStoreIds)', () => {
    const error = thrown(spec([{ hosted: 'file_search' }]));
    expect(error.errors).toHaveProperty('tools.0.options.vectorStoreIds');
  });

  it('rejects keys the hosted variant does not take', () => {
    const error = thrown(spec([{ hosted: 'web_search', approval: 'always' }]));
    expect(error.errors).toHaveProperty('tools.0');
    expect(error.message).toContain('approval');
  });

  it('rejects file refs that escape the agent folder or are not a code file', () => {
    for (const file of ['../x.ts', 'tools/x.py']) {
      const error = thrown(spec([{ file }]));
      expect(error.errors).toHaveProperty('tools.0.file');
    }
  });

  it("reports approval 'auto' as not supported yet", () => {
    const error = thrown(spec([{ builtin: 'web_fetch', approval: 'auto' }]));
    expect(error.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect(error.errors).toHaveProperty('tools.0.approval');
  });

  it("reports a registry 'version' as not supported yet", () => {
    const error = thrown(spec([{ registry: 'github-issues', version: '1.0.0' }]));
    expect(error.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect(error.errors).toHaveProperty('tools.0.version');
  });

  it('accepts an integration ref whose credentials are strings or secret refs', () => {
    const result = agentSpecV2Schema.safeParse(
      spec([{ integration: 'github', credentials: { token: { env: 'GITHUB_TOKEN' }, owner: 'acme', repo: 'web' } }])
    );
    expect(result.success).toBe(true);
  });

  it('refuses a literal string where the credential is a secret', () => {
    const error = thrown(
      spec([{ integration: 'github', credentials: { token: 'ghp_x', owner: 'acme', repo: 'web' } }])
    );
    expect(error.errors).toHaveProperty('tools.0.credentials.token');
    expect(error.message).toContain('is a secret');
  });

  it('names each required credential an integration ref misses', () => {
    const error = thrown(
      spec([{ integration: 'github', credentials: { token: { env: 'GITHUB_TOKEN' }, owner: 'acme' } }])
    );
    expect(error.errors).toHaveProperty('tools.0.credentials.repo');
    expect(error.message).toContain("'github' needs credentials.repo");
  });

  it('names a credential key the integration does not take', () => {
    const error = thrown(
      spec([
        {
          integration: 'jira',
          credentials: { baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: { env: 'JIRA_TOKEN' }, password: 'x' },
        },
      ])
    );
    expect(error.errors).toHaveProperty('tools.0.credentials.password');
    expect(error.message).toContain("unknown credential 'password' for 'jira'");
  });

  it('rejects an integration name the SDK has no tools for', () => {
    const error = thrown(spec([{ integration: 'teams', credentials: {} }]));
    expect(error.errors).toHaveProperty('tools.0.integration');
  });

  it('accepts an openapi ref with include and a bearer token ref', () => {
    const result = agentSpecV2Schema.safeParse(
      spec([
        { openapi: { url: 'https://api.example.com/openapi.json', include: ['getOrder'], bearerToken: { secret: 'orders' } } },
      ])
    );
    expect(result.success).toBe(true);
  });

  it('requires an https openapi url unless the host is loopback', () => {
    const error = thrown(spec([{ openapi: { url: 'http://api.example.com/x' } }]));
    expect(error.message).toContain('must be an https URL');
    const ok = agentSpecV2Schema.safeParse(spec([{ openapi: { url: 'http://localhost:3000/openapi.json' } }]));
    expect(ok.success).toBe(true);
  });

  it('requires the openapi bearer token to be a secret ref', () => {
    const error = thrown(spec([{ openapi: { url: 'https://x.test/o.json', bearerToken: 'abc' } }]));
    expect(error.errors).toHaveProperty('tools.0.openapi.bearerToken');
  });

  it('rejects duplicate ids', () => {
    const error = thrown(
      spec([
        { id: 'a', builtin: 'web_fetch' },
        { id: 'a', builtin: 'day_name' },
      ])
    );
    expect(error.errors).toHaveProperty('tools.1.id');
    expect(error.message).toContain("duplicate id 'a'");
  });
});
