/**
 * sec-signin-binding: the /oauth/callback is unauthenticated, so whoever holds a
 * sign-in link (e.g. any member of a Telegram group / Teams channel where the
 * channel posted it) completes it with THEIR OWN provider account, and the token
 * is stored for the user who asked. Also: anyone with the link can 'decline' it.
 */
import { z } from 'zod';
import { createAgent, defineTool, memoryStore, defineOAuthProvider } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const ALICE = { id: 'alice', type: 'user' as const, authenticator: 'jwt', issuer: 'https://id.example.com' };
const OWNER = { owner: 'user' as const, principalId: 'alice', issuer: 'https://id.example.com' };
const fakeFetch = (async (_u: unknown, init?: RequestInit) => {
  const code = new URLSearchParams(String(init?.body)).get('code');
  return new Response(JSON.stringify({ access_token: `token-of-${code}`, expires_in: 3600 }), { status: 200 });
}) as typeof fetch;
const github = defineOAuthProvider({ name: 'github', displayName: 'GitHub', authorizationUrl: 'https://gh.example/a', tokenUrl: 'https://gh.example/t',
  clientId: 'c', scopes: [], redirectUri: 'https://agent.example/oauth/callback', fetch: fakeFetch });
const tool = defineTool({ name: 'gh', description: 'gh', input: z.object({}), execute: async (_a, ctx) => ({ as: (await ctx.getToken(github)).accessToken.slice(0, 22) }) });
const store = memoryStore();
const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'gh', id: 'c1', args: {} }] }, { text: 'ok' }]), tools: [tool], store });

const paused = await agent.send('push my private notes to my gist', { principal: ALICE } as any);
const pending = (await agent.approvals.list())[0] as any;
const state = new URL(pending.signIn.url).searchParams.get('state')!;
console.log('alice run:', paused.finishReason, '-> link posted in the group');
// Mallory (a group member) opens the link, logs in to GitHub as herself; GitHub redirects HER browser to the callback.
// The built-in GET /oauth/callback passes a principal only if the browser request passes route auth -> undefined here.
const done = await agent.oauth.complete({ state, code: 'mallory-code' });
console.log('callback outcome:', done.outcome);
console.log("token stored for ALICE:", (await store.tokens!.get('github', OWNER))?.accessToken);
