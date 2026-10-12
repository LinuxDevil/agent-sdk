/**
 * sec-token-redaction: docs/oauth.md promises a tool result containing a token
 * handed out by ctx.getToken() is replaced with [REDACTED] "before it is recorded".
 * Try shapes a real tool plausibly returns/throws and check the recorded tool message.
 */
import { z } from 'zod';
import { createAgent, defineTool, memoryStore, defineOAuthProvider } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const ALICE = { id: 'alice', type: 'user' as const, authenticator: 'jwt', issuer: 'https://id.example.com' };
const OWNER = { owner: 'user' as const, principalId: 'alice', issuer: 'https://id.example.com' };
const TOKEN = 'gho_SECRETTOKEN123456';
const github = defineOAuthProvider({
  name: 'github', displayName: 'GitHub', authorizationUrl: 'https://gh.example/a', tokenUrl: 'https://gh.example/t',
  clientId: 'c', scopes: [], redirectUri: 'https://agent.example/oauth/callback', fetch: (async () => new Response('{}')) as typeof fetch,
});

const variants: Record<string, (t: string) => unknown> = {
  plainString: (t) => `token=${t}`,
  objectKey: (t) => ({ [t]: 'scopes: repo' }),
  urlInstance: (t) => ({ next: new URL(`https://api.example/?access_token=${t}`) }),
  mapInstance: (t) => new Map([['auth', `Bearer ${t}`]]),
  classInstance: (t) => new (class Debug { header = `Bearer ${t}`; })(),
  base64: (t) => ({ basic: Buffer.from(`x-access-token:${t}`).toString('base64') }),
  thrownError: (t) => { throw new Error(`GitHub 401 for Authorization: Bearer ${t}`); },
};

for (const [name, make] of Object.entries(variants)) {
  const store = memoryStore();
  await store.tokens!.set('github', OWNER, { accessToken: TOKEN });
  const tool = defineTool({ name: 'gh', description: 'gh', input: z.object({}), execute: async (_a, ctx) => make((await ctx.getToken(github)).accessToken) as any });
  const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'gh', id: 'c1', args: {} }] }, { text: 'ok' }]), tools: [tool], store });
  const warn = console.warn; console.warn = () => {};
  const r = await agent.send('go', { principal: ALICE } as any);
  console.warn = warn;
  const toolMsg = r.messages.find((m: any) => m.role === 'tool');
  const content = String(toolMsg?.content);
  const leaked = content.includes(TOKEN) || content.includes(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
  console.log(`${name.padEnd(14)} leaked=${leaked}  recorded=${content.replace(TOKEN, '<TOKEN>').slice(0, 110)}`);
}
