import { describe, it, expect } from 'vitest';
import { agentSpecSchema, type AgentSpec } from './schema';

const base = { name: 'bot', prompt: 'hi', provider: { type: 'mock', model: 'm' } };

function issues(mcpServers: unknown): string[] {
  const result = agentSpecSchema.safeParse({ ...base, mcpServers });
  if (result.success) throw new Error('expected validation to fail');
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('AgentSpec.mcpServers (LOU-D20)', () => {
  it('accepts stdio and HTTP entries', () => {
    const mcpServers: AgentSpec['mcpServers'] = {
      fs: { command: 'npx', args: ['-y', 'server-fs'], env: { ROOT: '/tmp' } },
      git: { command: 'uvx' },
      docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
    };
    expect(agentSpecSchema.parse({ ...base, mcpServers }).mcpServers).toEqual(mcpServers);
  });

  it('still validates specs without the field', () => {
    expect(agentSpecSchema.parse(base)).toEqual(base);
  });

  it('rejects an entry with neither command nor url, naming the entry', () => {
    expect(issues({ broken: { args: ['x'] } })).toEqual([
      "mcpServers.broken: AgentSpec validation failed: missing 'command' (stdio server) or 'url' (HTTP server)",
    ]);
  });

  it('rejects an entry with both command and url', () => {
    expect(issues({ both: { command: 'npx', url: 'https://example.com' } })[0]).toMatch(
      /^mcpServers\.both: AgentSpec validation failed: set either 'command'/
    );
  });

  it('rejects stdio-only fields on an HTTP server and headers on a stdio server', () => {
    expect(issues({ a: { url: 'https://example.com', env: { K: 'v' } } })[0]).toMatch(
      /'env' does not apply to an HTTP/
    );
    expect(issues({ b: { command: 'npx', headers: { K: 'v' } } })[0]).toMatch(
      /'headers' does not apply to a stdio/
    );
  });

  it('rejects a bad env type and a bad url', () => {
    expect(issues({ fs: { command: 'npx', env: ['A=1'] } })).toEqual([
      "mcpServers.fs.env: AgentSpec validation failed: 'env' must be a map of string to string",
    ]);
    expect(issues({ fs: { command: 'npx', env: { A: 1 } } })[0]).toMatch(
      /^mcpServers\.fs\.env\.A: /
    );
    expect(issues({ web: { url: 'not a url' } })[0]).toMatch(/'url' must be a valid URL/);
  });

  it('accepts the legacy list form that loushy doctor used to read', () => {
    const parsed = agentSpecSchema.parse({
      ...base,
      mcpServers: [{ name: 'fs', command: 'npx' }, { url: 'https://example.com' }],
    });
    expect(parsed.mcpServers).toEqual({
      fs: { command: 'npx' },
      '#2': { url: 'https://example.com' },
    });
  });
});
