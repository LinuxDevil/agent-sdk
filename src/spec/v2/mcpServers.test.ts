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
});
