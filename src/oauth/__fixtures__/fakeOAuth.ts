/**
 * N9b test helpers: a fake OAuth token endpoint (a `fetch` fake), a provider
 * that uses it, and a GitHub-like tool that asks for a token.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '../../tools/defineTool';
import type { Principal } from '../../auth/types';
import { defineOAuthProvider, type OAuthProvider, type OAuthProviderOptions } from '../defineOAuthProvider';

export const ALICE: Principal = { id: 'alice', type: 'user', authenticator: 'jwt', issuer: 'https://id.example.com' };
export const BOB: Principal = { id: 'bob', type: 'user', authenticator: 'jwt', issuer: 'https://id.example.com' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A token endpoint: `code-<x>` codes are exchanged for `gho_SECRET_<x>_<n>`; refreshes work until `refusing`. */
export function fakeOAuthServer() {
  const requests: URLSearchParams[] = [];
  const server = { requests, issued: 0, refuseRefresh: false, headers: [] as Headers[] };
  const handler = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    requests.push(body);
    server.headers.push(new Headers(init?.headers));
    if (body.get('grant_type') === 'authorization_code') {
      const code = body.get('code') ?? '';
      if (!code.startsWith('code-')) return json(400, { error: 'invalid_grant', error_description: `bad code ${code}` });
      server.issued++;
      return json(200, { access_token: `gho_SECRET_${code.slice(5)}_${server.issued}`, refresh_token: `ghr_SECRET_${server.issued}`, token_type: 'bearer', expires_in: 3600, scope: 'repo' });
    }
    if (body.get('grant_type') === 'refresh_token') {
      if (server.refuseRefresh) return json(400, { error: 'invalid_grant' });
      server.issued++;
      return json(200, { access_token: `gho_SECRET_refreshed_${server.issued}`, token_type: 'bearer', expires_in: 3600 });
    }
    return json(400, { error: 'unsupported_grant_type' });
  };
  return Object.assign(server, { fetch: handler as typeof fetch });
}

export type FakeOAuthServer = ReturnType<typeof fakeOAuthServer>;

export function githubProvider(server: FakeOAuthServer, options: Partial<OAuthProviderOptions> = {}): OAuthProvider {
  return defineOAuthProvider({
    name: 'github',
    displayName: 'GitHub',
    authorizationUrl: 'https://github.example.com/login/oauth/authorize',
    tokenUrl: 'https://github.example.com/login/oauth/access_token',
    clientId: 'client-123',
    clientSecret: 'client-secret-xyz',
    scopes: ['repo', 'read:user'],
    redirectUri: 'https://agent.example.com/api/agent/oauth/callback',
    fetch: server.fetch,
    ...options,
  });
}

/** The PKCE S256 challenge of `verifier`. */
export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * `list_repos`: asks for a GitHub token (before any side effect), then
 * "calls the API". `executions` records each call that got past `getToken`
 * with the token it got; a token in `revoked` answers 401 (`requireAuth`).
 */
export function listReposTool(provider: OAuthProvider, options: { needsApproval?: boolean; returnToken?: boolean; revoked?: Set<string> } = {}) {
  const executions: string[] = [];
  const tool = defineTool({
    name: 'list_repos',
    description: 'Lists the repositories of the signed-in GitHub user',
    input: z.object({}),
    ...(options.needsApproval && { needsApproval: true }),
    execute: async (_args, ctx) => {
      const { accessToken } = await ctx.getToken(provider);
      if (options.revoked?.has(accessToken)) ctx.requireAuth(provider);
      executions.push(accessToken);
      return options.returnToken ? { repos: ['lousho-demo'], debug: `token=${accessToken}` } : { repos: ['lousho-demo', 'agent-sdk'] };
    },
  });
  return { tool, executions };
}
