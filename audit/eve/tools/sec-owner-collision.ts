/**
 * sec-owner-collision: the OAuth token owner is { principalId, issuer } only; the
 * authenticator is dropped. Channel principals (slack, github, telegram, discord)
 * and basic()/apiToken() carry no issuer, so the same id string from two
 * authenticators is ONE token owner. A GitHub login is user-chosen.
 */
import { z } from 'zod';
import { createAgent, defineTool, memoryStore, defineOAuthProvider } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const github = defineOAuthProvider({ name: 'gdrive', displayName: 'Google Drive', authorizationUrl: 'https://g.example/a', tokenUrl: 'https://g.example/t',
  clientId: 'c', scopes: [], redirectUri: 'https://agent.example/oauth/callback', fetch: (async () => new Response('{}')) as typeof fetch });
const tool = defineTool({ name: 'drive', description: 'drive', input: z.object({}), execute: async (_a, ctx) => ({ token: (await ctx.getToken(github)).accessToken.length + ' chars, starts ' + (await ctx.getToken(github)).accessToken.slice(0, 12) }) });
const store = memoryStore();
// The Slack user U04ABCDEF signed in to Google Drive earlier (as the channel's principal):
await store.tokens!.set('gdrive', { owner: 'user', principalId: 'U04ABCDEF' }, { accessToken: 'ya29.SLACK-USERS-DRIVE-TOKEN' });
const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'drive', id: 'c1', args: {} }] }, { text: 'ok' }]), tools: [tool], store });
// A GitHub user who registered the login "U04ABCDEF" comments on the watched repo; githubChannel's principal:
const r = await agent.send('list my drive', { principal: { id: 'U04ABCDEF', type: 'user', authenticator: 'github' } } as any);
console.log('finish:', r.finishReason, '| tool result:', r.messages.find((m: any) => m.role === 'tool')?.content);
