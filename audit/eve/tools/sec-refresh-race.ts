/**
 * sec-refresh-race: two concurrent tool calls for the same user hit getToken()
 * while the stored token is about to expire. The provider rotates refresh
 * tokens (single use, like Auth0 rotation / Microsoft / Atlassian / Salesforce).
 * Expected: one refresh wins, both calls get a token, the store keeps the new one.
 */
import { z } from 'zod';
import { createAgent, defineTool, memoryStore, defineOAuthProvider } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const ALICE = { id: 'alice', type: 'user' as const, authenticator: 'jwt', issuer: 'https://id.example.com' };
const OWNER = { owner: 'user' as const, principalId: 'alice', issuer: 'https://id.example.com' };

let live = 'R0'; // the one refresh token the server currently accepts
let n = 0;
const log: string[] = [];
const fakeFetch = (async (_u: unknown, init?: RequestInit) => {
  const body = new URLSearchParams(String(init?.body ?? ''));
  await new Promise((r) => setTimeout(r, 30));
  if (body.get('grant_type') === 'refresh_token') {
    const presented = body.get('refresh_token');
    if (presented !== live) { log.push(`refresh with ${presented}: invalid_grant`); return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }); }
    n++; live = `R${n}`;
    log.push(`refresh with ${presented}: ok -> A${n}/R${n}`);
    return new Response(JSON.stringify({ access_token: `A${n}`, refresh_token: live, expires_in: 3600 }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: 'unsupported_grant_type' }), { status: 400 });
}) as typeof fetch;

const github = defineOAuthProvider({
  name: 'github', displayName: 'GitHub',
  authorizationUrl: 'https://gh.example/authorize', tokenUrl: 'https://gh.example/token',
  clientId: 'c', clientSecret: 's', scopes: ['repo'], redirectUri: 'https://agent.example/oauth/callback', fetch: fakeFetch,
});
const got: string[] = [];
const tool = defineTool({
  name: 'list_repos', description: 'list repos', input: z.object({}),
  execute: async (_a, ctx) => { const t = await ctx.getToken(github); got.push(t.accessToken); return { ok: true }; },
});

const store = memoryStore();
await store.tokens!.set('github', OWNER, { accessToken: 'A0', refreshToken: 'R0', expiresAt: Date.now() + 10_000 });

const mk = () => createAgent({ provider: mockModel([{ toolCalls: [{ name: 'list_repos', id: 'c1', args: {} }] }, { text: 'done' }]), tools: [tool], store });
const [r1, r2] = await Promise.all([mk().send('list', { principal: ALICE, sessionId: 's1' } as any), mk().send('list', { principal: ALICE, sessionId: 's2' } as any)]);
console.log('provider log:', log);
console.log('finishReasons:', r1.finishReason, r2.finishReason);
console.log('tool got tokens:', got);
console.log('stored token after:', await store.tokens!.get('github', OWNER));
console.log('server-side live refresh token:', live);
