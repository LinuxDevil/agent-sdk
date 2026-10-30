import { describe, it, expect } from 'vitest';
import { issueMessage, issuePath } from '../../utils/zodCompat';
import { agentSpecV2Schema } from './schema';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function parse(mcpServers: unknown) {
  return agentSpecV2Schema.safeParse({ ...base, mcpServers });
}

describe('agentSpecV2Schema mcpServers', () => {
  it('accepts stdio and HTTP entries keyed by name', () => {
    const result = parse({ fs: { command: 'npx', args: ['-y', 'server-fs'] }, docs: { url: 'https://example.com/mcp' } });
    expect(result.success).toBe(true);
  });

  it("reports an entry's invalid field at mcpServers.<name>.<field> without v1's prefix", () => {
    const result = parse({ fs: { command: 'npx', stderr: 'loud' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues[0];
    expect(issuePath(issue)).toBe('mcpServers.fs.stderr');
    expect(issueMessage(issue)).toBe("'stderr' must be 'forward', 'capture', 'inherit' or 'ignore'");
  });

  it('rejects stdio-only fields on an HTTP server', () => {
    const result = parse({ docs: { url: 'https://example.com/mcp', cwd: '/srv' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0].message).toMatch(/'cwd' does not apply to an HTTP/);
  });

  it('rejects a server name outside the tool-name alphabet', () => {
    const result = parse({ 'my server': { command: 'x' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.message.includes('server names'))).toBe(true);
  });

  it("rejects v1's legacy list form", () => {
    const result = parse([{ name: 'fs', command: 'npx' }]);
    expect(result.success).toBe(false);
  });

  it('accepts a SecretRef in stdio env values', () => {
    const result = parse({ gh: { command: 'npx', env: { GITHUB_TOKEN: { env: 'GITHUB_TOKEN' }, LOG: 'debug' } } });
    expect(result.success).toBe(true);
  });

  it('accepts a SecretRef in HTTP headers', () => {
    const result = parse({ api: { url: 'https://x.test/mcp', headers: { Authorization: { secret: 'api-key' } } } });
    expect(result.success).toBe(true);
  });

  it('accepts a SecretRef in oauth.clientSecret', () => {
    const result = parse({
      api: { url: 'https://x.test/mcp', oauth: { redirectUri: 'https://a.test/cb', clientId: 'c', clientSecret: { secret: 'cs' } } },
    });
    expect(result.success).toBe(true);
  });

  it('reports a bad ref at mcpServers.<server>.env.<KEY>.env', () => {
    const result = parse({ gh: { command: 'npx', env: { T: { env: 'bad name' } } } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePath(result.error.issues[0])).toBe('mcpServers.gh.env.T.env');
  });

  it("keeps v1's message for values that are neither strings nor refs", () => {
    const result = parse({ gh: { command: 'npx', env: { T: 42 } } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issueMessage(issue).includes('must be a map of string to string'))).toBe(true);
  });
});
