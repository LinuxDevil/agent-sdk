import { describe, it, expect } from 'vitest';
import { ConfigurationError } from '../../../execution/errors';
import { mcpServerSpecSchema } from '../../schema';
import { resolveMcpServers } from './mcpServers';
import type { McpServerSpecV2 } from '../mcpServers';

describe('resolveMcpServers', () => {
  it('resolves env refs from host.env and produces a v1-valid entry', async () => {
    const servers: Record<string, McpServerSpecV2> = {
      gh: { command: 'npx', env: { GITHUB_TOKEN: { env: 'GITHUB_TOKEN' }, LOG: 'debug' } },
    };
    const result = await resolveMcpServers(servers, { env: { GITHUB_TOKEN: 't' } });
    expect(result.gh).toEqual({ command: 'npx', env: { GITHUB_TOKEN: 't', LOG: 'debug' } });
    expect(mcpServerSpecSchema.safeParse(result.gh).success).toBe(true);
  });

  it('resolves oauth.clientSecret through the host secret store', async () => {
    const servers: Record<string, McpServerSpecV2> = {
      api: {
        url: 'https://x.test/mcp',
        oauth: { redirectUri: 'https://a.test/cb', clientId: 'c', clientSecret: { secret: 'cs' } },
      },
    };
    const result = await resolveMcpServers(servers, { resolveSecret: () => 's3' });
    expect(result.api).toEqual({
      url: 'https://x.test/mcp',
      oauth: { redirectUri: 'https://a.test/cb', clientId: 'c', clientSecret: 's3' },
    });
    expect(mcpServerSpecSchema.safeParse(result.api).success).toBe(true);
  });

  it('fails with LOUSHO_SPEC_SECRET_MISSING naming the header field when the secret is missing', async () => {
    const servers: Record<string, McpServerSpecV2> = {
      api: { url: 'https://x.test/mcp', headers: { Authorization: { secret: 'api-key' } } },
    };
    try {
      await resolveMcpServers(servers, { resolveSecret: () => undefined });
      throw new Error('expected rejection');
    } catch (error) {
      const e = error as ConfigurationError;
      expect(e.code).toBe('LOUSHO_SPEC_SECRET_MISSING');
      expect(e.field).toBe('mcpServers.api.headers.Authorization');
    }
  });
});
