/**
 * N9b: `ctx.getToken()` pauses the run until the user signs in. A fake OAuth
 * token endpoint (a `fetch` fake) and `mockModel` drive every flow offline:
 * pause, callback, resume; refresh; `requireAuth`; principal and app
 * credentials; declining; approval and sign-in together; the result safety net.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { defineTool } from '../tools/defineTool';
import { memoryStore } from '../storage/agentStore';
import type { AgentEvent, AgentEventOf } from '../execution/agentEvents';
import type { ExecutionResult } from '../execution/AgentExecutor';
import { defineOAuthProvider } from './defineOAuthProvider';
import { SignInPendingError, completeSignIn, startSignIn } from './signIn';
import { MemoryTokenStore } from './memoryTokenStore';
import { ALICE, BOB, challengeOf, fakeOAuthServer, githubProvider, listReposTool, type FakeOAuthServer } from './__fixtures__/fakeOAuth';
import type { TokenOwner } from './types';

afterEach(() => vi.restoreAllMocks());

const ALICE_OWNER: TokenOwner = { owner: 'user', principalId: 'alice', issuer: 'https://id.example.com' };
const CALL = { toolCalls: [{ name: 'list_repos', id: 'call_1', args: {} }] };

function script(final = 'You have lousho-demo and agent-sdk.') {
  return mockModel([CALL, { text: final }]);
}

async function collect(run: AsyncIterable<AgentEvent> & { result: Promise<ExecutionResult> }) {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return { events, result: await run.result };
}

function approvalEvent(events: AgentEvent[]): AgentEventOf<'approval.requested'> {
  const found = events.find((event): event is AgentEventOf<'approval.requested'> => event.type === 'approval.requested');
  if (!found) throw new Error('no approval.requested event');
  return found;
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state') ?? '';
}

function toolMessage(result: ExecutionResult): Record<string, unknown> {
  const message = result.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_1');
  return JSON.parse(String(message?.content)) as Record<string, unknown>;
}

function setup(server: FakeOAuthServer = fakeOAuthServer(), options: Parameters<typeof listReposTool>[1] = {}, final?: string) {
  const github = githubProvider(server);
  const { tool, executions } = listReposTool(github, options);
  const store = memoryStore();
  const agent = createAgent({ provider: script(final), tools: [tool], store });
  return { server, github, executions, store, agent };
}

describe('ctx.getToken(): pause until sign-in (N9b)', () => {
  it('pauses with a sign-in link, exchanges the code with the right PKCE verifier, and re-runs the tool on approval', async () => {
    const { server, executions, store, agent } = setup();
    const paused = await collect(agent.stream('List my repositories.', { principal: ALICE }));

    expect(paused.result.finishReason).toBe('awaiting-approval');
    const event = approvalEvent(paused.events);
    expect(event).toMatchObject({ kind: 'sign-in', toolName: 'list_repos', signIn: { provider: 'github', displayName: 'GitHub' } });
    const url = new URL(event.signIn?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://github.example.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-123',
      redirect_uri: 'https://agent.example.com/api/agent/oauth/callback',
      scope: 'repo read:user',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(executions).toEqual([]);
    // the pause is listed like an approval, with its link
    expect(await agent.approvals.list()).toMatchObject([{ id: event.approvalId, kind: 'sign-in', signIn: { url: event.signIn?.url }, principal: { id: 'alice' } }]);

    const completed = await agent.oauth.complete({ state: url.searchParams.get('state') ?? '', code: 'code-alice' });
    expect(completed).toMatchObject({ approvalId: event.approvalId, outcome: 'signed-in', provider: 'github', displayName: 'GitHub' });
    const exchange = server.requests[0];
    expect(Object.fromEntries(exchange)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-alice',
      redirect_uri: 'https://agent.example.com/api/agent/oauth/callback',
      client_id: 'client-123',
      client_secret: 'client-secret-xyz',
    });
    expect(challengeOf(exchange.get('code_verifier') ?? '')).toBe(url.searchParams.get('code_challenge'));
    expect((await store.tokens.get('github', ALICE_OWNER))?.accessToken).toBe('gho_SECRET_alice_1');

    const resumed = await agent.approvals.resolve({ id: event.approvalId, approved: true });
    expect(resumed.finishReason).toBe('stop');
    expect(resumed.text).toBe('You have lousho-demo and agent-sdk.');
    expect(executions).toEqual(['gho_SECRET_alice_1']);
    expect(toolMessage(resumed)).toEqual({ repos: ['lousho-demo', 'agent-sdk'] });
  });

  it('approving before the user signed in throws LOUSHO_SIGNIN_PENDING and leaves the pause in place', async () => {
    const { agent, executions } = setup();
    const session = agent.session({ id: 'chat' });
    const paused = await session.send('List my repositories.', { principal: ALICE });
    const id = paused.approvalId ?? '';

    const early = agent.approvals.resolve({ id, approved: true });
    await expect(early).rejects.toBeInstanceOf(SignInPendingError);
    await expect(early).rejects.toMatchObject({ code: 'LOUSHO_SIGNIN_PENDING' });
    expect((await agent.approvals.list()).map((a) => a.id)).toEqual([id]);
    expect(executions).toEqual([]);

    const [pending] = await agent.approvals.list();
    await agent.oauth.complete({ state: stateOf(pending.signIn?.url ?? ''), code: 'code-alice' });
    const resumed = await agent.approvals.resolve({ id, approved: true });
    expect(resumed.finishReason).toBe('stop');
    // still the session's turn: the transcript has the whole exchange
    expect((await session.load()).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('never asks the `approve` callback about a sign-in', async () => {
    const approve = vi.fn(() => true);
    const github = githubProvider(fakeOAuthServer());
    const { tool } = listReposTool(github);
    const agent = createAgent({ provider: script(), tools: [tool], store: memoryStore(), approve });
    const result = await agent.send('List my repositories.', { principal: ALICE });
    expect(result.finishReason).toBe('awaiting-approval');
    expect(approve).not.toHaveBeenCalled();
  });

  it('a state works once, for 10 minutes, and only for the user it was made for', async () => {
    const { agent } = setup();
    const paused = await agent.send('List my repositories.', { principal: ALICE });
    const [pending] = await agent.approvals.list();
    const state = stateOf(pending.signIn?.url ?? '');

    await expect(agent.oauth.complete({ state, code: 'code-bob', principal: BOB })).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STATE_INVALID' });
    await expect(agent.oauth.complete({ state: 'x'.repeat(43), code: 'code-alice' })).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STATE_INVALID' });
    // Bob's refused attempt did not burn Alice's link
    await expect(agent.oauth.complete({ state, code: 'code-alice', principal: ALICE })).resolves.toMatchObject({ approvalId: paused.approvalId });
    await expect(agent.oauth.complete({ state, code: 'code-alice' })).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STATE_INVALID' });

    const tokens = new MemoryTokenStore();
    const url = await startSignIn(githubProvider(fakeOAuthServer()), ALICE_OWNER, tokens);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000 + 1);
    await expect(completeSignIn({ state: stateOf(url), code: 'code-alice' }, tokens)).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STATE_INVALID' });
  });

  it('a refused code exchange is LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED and never echoes the code or the response body', async () => {
    const { agent } = setup();
    await agent.send('List my repositories.', { principal: ALICE });
    const [pending] = await agent.approvals.list();
    const failure = await agent.oauth.complete({ state: stateOf(pending.signIn?.url ?? ''), code: 'stolen-code-123' }).catch((error: unknown) => error as Error & { code: string });
    expect(failure).toMatchObject({ code: 'LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED' });
    expect(failure.message).toContain('HTTP 400 (invalid_grant)');
    expect(failure.message).not.toContain('stolen-code-123');
  });

  it('declining at the provider cancels the call: approving then gives the model a denied result', async () => {
    const { agent, executions } = setup(undefined, {}, 'Okay, I will not list them.');
    const paused = await agent.send('List my repositories.', { principal: ALICE });
    const [pending] = await agent.approvals.list();
    const declined = await agent.oauth.complete({ state: stateOf(pending.signIn?.url ?? ''), error: 'access_denied' });
    expect(declined).toMatchObject({ approvalId: paused.approvalId, outcome: 'declined' });

    const resumed = await agent.approvals.resolve({ id: paused.approvalId ?? '', approved: true });
    expect(resumed.finishReason).toBe('stop');
    expect(toolMessage(resumed)).toMatchObject({ kind: 'denied', message: 'Sign-in to GitHub was cancelled.' });
    expect(executions).toEqual([]);
  });

  it('approved: false cancels a sign-in pause the same way', async () => {
    const { agent, executions } = setup(undefined, {}, 'Okay.');
    const paused = await agent.send('List my repositories.', { principal: ALICE });
    const resumed = await agent.approvals.resolve({ id: paused.approvalId ?? '', approved: false });
    expect(toolMessage(resumed)).toMatchObject({ kind: 'denied', message: 'Sign-in to GitHub was cancelled.' });
    expect(executions).toEqual([]);
  });

  it('a tool that needs approval and a sign-in: approve, sign in, then one execution and no second approval prompt', async () => {
    const { agent, executions } = setup(undefined, { needsApproval: true });
    const asked: AgentEventOf<'approval.requested'>[] = [];
    const watch = (event: AgentEvent) => void (event.type === 'approval.requested' && asked.push(event));

    const first = await collect(agent.stream('List my repositories.', { principal: ALICE }));
    first.events.forEach(watch);
    expect(asked.map((a) => a.kind)).toEqual([undefined]);

    const second = await collect(agent.approvals.streamResolve({ id: asked[0].approvalId, approved: true }));
    second.events.forEach(watch);
    expect(second.result.finishReason).toBe('awaiting-approval');
    expect(asked.map((a) => a.kind)).toEqual([undefined, 'sign-in']);
    expect(executions).toEqual([]);

    await agent.oauth.complete({ state: stateOf(asked[1].signIn?.url ?? ''), code: 'code-alice' });
    const done = await collect(agent.approvals.streamResolve({ id: asked[1].approvalId, approved: true }));
    done.events.forEach(watch);
    expect(done.result.finishReason).toBe('stop');
    expect(executions).toEqual(['gho_SECRET_alice_1']);
    expect(asked).toHaveLength(2);
  });
});

describe('stored tokens: refresh and requireAuth (N9b)', () => {
  it('refreshes a token that expires within 60 s, without a pause', async () => {
    const { server, store, agent, executions } = setup();
    await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_old', refreshToken: 'ghr_SECRET_old', expiresAt: Date.now() + 30_000 });

    const result = await agent.send('List my repositories.', { principal: ALICE });
    expect(result.finishReason).toBe('stop');
    expect(executions).toEqual(['gho_SECRET_refreshed_1']);
    expect(Object.fromEntries(server.requests[0])).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ghr_SECRET_old', scope: 'repo read:user' });
    // the new token is stored, and keeps the refresh token the server did not replace
    expect(await store.tokens.get('github', ALICE_OWNER)).toMatchObject({ accessToken: 'gho_SECRET_refreshed_1', refreshToken: 'ghr_SECRET_old' });
  });

  it('a failed refresh deletes the token and pauses for sign-in', async () => {
    const server = fakeOAuthServer();
    server.refuseRefresh = true;
    const { store, agent, executions } = setup(server);
    await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_old', refreshToken: 'ghr_SECRET_old', expiresAt: Date.now() - 1 });

    const result = await agent.send('List my repositories.', { principal: ALICE });
    expect(result.finishReason).toBe('awaiting-approval');
    expect((await agent.approvals.list())[0].kind).toBe('sign-in');
    expect(await store.tokens.get('github', ALICE_OWNER)).toBeUndefined();
    expect(executions).toEqual([]);
  });

  it('uses a fresh token as is, and an expired one without a refresh token means sign-in', async () => {
    const { server, store, agent, executions } = setup();
    await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_fresh', expiresAt: Date.now() + 3_600_000 });
    expect((await agent.send('List my repositories.', { principal: ALICE })).finishReason).toBe('stop');
    expect(executions).toEqual(['gho_SECRET_fresh']);
    expect(server.requests).toEqual([]);

    const again = setup();
    await again.store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_stale', expiresAt: Date.now() - 1 });
    expect((await again.agent.send('List my repositories.', { principal: ALICE })).finishReason).toBe('awaiting-approval');
  });

  it('requireAuth() after a 401 deletes the token and pauses; after a new sign-in the call succeeds', async () => {
    const revoked = new Set(['gho_SECRET_revoked']);
    const { store, agent, executions } = setup(undefined, { revoked });
    await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_revoked', expiresAt: Date.now() + 3_600_000 });

    const paused = await agent.send('List my repositories.', { principal: ALICE });
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(await store.tokens.get('github', ALICE_OWNER)).toBeUndefined();
    expect(executions).toEqual([]);

    const [pending] = await agent.approvals.list();
    await agent.oauth.complete({ state: stateOf(pending.signIn?.url ?? ''), code: 'code-alice' });
    expect((await agent.approvals.resolve({ id: pending.id, approved: true })).finishReason).toBe('stop');
    expect(executions).toEqual(['gho_SECRET_alice_1']);
  });

  it('a token that goes bad again after the resume pauses again with a new link', async () => {
    const revoked = new Set<string>(['gho_SECRET_alice_1']);
    const { agent, executions } = setup(undefined, { revoked });
    await agent.send('List my repositories.', { principal: ALICE });
    const [first] = await agent.approvals.list();
    await agent.oauth.complete({ state: stateOf(first.signIn?.url ?? ''), code: 'code-alice' });

    const again = await agent.approvals.resolve({ id: first.id, approved: true });
    expect(again.finishReason).toBe('awaiting-approval');
    const [second] = await agent.approvals.list();
    expect(second).toMatchObject({ kind: 'sign-in', toolName: 'list_repos' });
    expect(second.id).not.toBe(first.id);
    expect(second.signIn?.url).not.toBe(first.signIn?.url);

    await agent.oauth.complete({ state: stateOf(second.signIn?.url ?? ''), code: 'code-alice' });
    expect((await agent.approvals.resolve({ id: second.id, approved: true })).finishReason).toBe('stop');
    expect(executions).toEqual(['gho_SECRET_alice_2']);
  });
});

describe('who owns the credential (N9b)', () => {
  it("a user credential on a run without a principal is a tool error, with no pause", async () => {
    const { agent, executions } = setup(undefined, {}, 'I cannot tell who you are.');
    const { events, result } = await collect(agent.stream('List my repositories.'));
    expect(result.finishReason).toBe('stop');
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(JSON.stringify(toolMessage(result))).toContain('LOUSHO_OAUTH_PRINCIPAL_REQUIRED');
    expect(executions).toEqual([]);
  });

  it("an app credential is never asked of a chat user; the operator's signInUrl() connects it for everyone", async () => {
    const server = fakeOAuthServer();
    const slack = defineOAuthProvider({
      name: 'slack_bot',
      displayName: 'Slack',
      credentialOwner: 'app',
      authorizationUrl: 'https://slack.example.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.example.com/api/oauth.v2.access',
      clientId: 'slack-client',
      clientSecret: 'slack-secret',
      clientAuth: 'client_secret_basic',
      redirectUri: 'https://agent.example.com/oauth/callback',
      fetch: server.fetch,
    });
    const seen: string[] = [];
    const post = defineTool({
      name: 'post_update',
      description: 'Posts to the team channel',
      input: z.object({}),
      execute: async (_args, ctx) => {
        seen.push((await ctx.getToken(slack)).accessToken);
        return 'posted';
      },
    });
    const store = memoryStore();
    const turns = [{ toolCalls: [{ name: 'post_update', id: 'call_1', args: {} }] }, { text: 'Done.' }];
    const agent = createAgent({ provider: mockModel([...turns, ...turns, ...turns, ...turns]), tools: [post], store });

    const before = await collect(agent.stream('Post the update.', { principal: ALICE }));
    expect(before.events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(JSON.stringify(before.events)).not.toContain('code_challenge');
    expect(JSON.stringify(toolMessage(before.result))).toContain('LOUSHO_OAUTH_APP_SIGNIN_REQUIRED');

    const url = await agent.oauth.signInUrl(slack);
    expect(await agent.approvals.list()).toEqual([]);
    expect(await agent.oauth.complete({ state: stateOf(url), code: 'code-app' })).toEqual({ outcome: 'signed-in', provider: 'slack_bot', displayName: 'Slack' });
    // client_secret_basic: the secret is in the header, not the form
    expect(server.headers[0].get('authorization')).toBe(`Basic ${Buffer.from('slack-client:slack-secret').toString('base64')}`);
    expect(server.requests[0].get('client_secret')).toBeNull();

    expect((await agent.send('Post the update.')).finishReason).toBe('stop');
    expect((await agent.send('Post the update.', { principal: ALICE })).finishReason).toBe('stop');
    expect((await agent.send('Post the update.', { principal: BOB })).finishReason).toBe('stop');
    expect(seen).toEqual(['gho_SECRET_app_1', 'gho_SECRET_app_1', 'gho_SECRET_app_1']);
    await expect(agent.oauth.signInUrl(githubProvider(server))).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });

  it("two users' tokens never cross", async () => {
    const server = fakeOAuthServer();
    const github = githubProvider(server);
    const { tool, executions } = listReposTool(github);
    const store = memoryStore();
    const agent = createAgent({ provider: mockModel([CALL, { text: 'a' }, CALL, { text: 'b' }, CALL, { text: 'c' }, CALL, { text: 'd' }]), tools: [tool], store });

    for (const [principal, code] of [[ALICE, 'code-alice'], [BOB, 'code-bob']] as const) {
      const paused = await agent.send('List my repositories.', { principal });
      const pending = (await agent.approvals.list()).find((a) => a.id === paused.approvalId);
      await agent.oauth.complete({ state: stateOf(pending?.signIn?.url ?? ''), code });
      await agent.approvals.resolve({ id: paused.approvalId ?? '', approved: true });
    }
    expect(executions).toEqual(['gho_SECRET_alice_1', 'gho_SECRET_bob_2']);

    await agent.send('List my repositories.', { principal: BOB });
    await agent.send('List my repositories.', { principal: ALICE });
    expect(executions.slice(2)).toEqual(['gho_SECRET_bob_2', 'gho_SECRET_alice_1']);
    // same id from another issuer is another user
    expect(await store.tokens.get('github', { owner: 'user', principalId: 'alice', issuer: 'https://evil.example.com' })).toBeUndefined();
  });

  it('a run without a token store stops with LOUSHO_OAUTH_STORE_MISSING', async () => {
    const github = githubProvider(fakeOAuthServer());
    const { tool } = listReposTool(github);
    const agent = createAgent({ provider: script(), tools: [tool] });
    await expect(agent.send('List my repositories.', { principal: ALICE })).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STORE_MISSING' });
    await expect(agent.oauth.complete({ state: 'x'.repeat(43), code: 'c' })).rejects.toMatchObject({ code: 'LOUSHO_OAUTH_STORE_MISSING' });
  });
});

describe('a tool never returns a token (N9b)', () => {
  it('a result containing a token from getToken() has it replaced with [REDACTED], with a warning naming the tool', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { store, agent } = setup(undefined, { returnToken: true });
    await store.tokens.set('github', ALICE_OWNER, { accessToken: 'gho_SECRET_leaky', expiresAt: Date.now() + 3_600_000 });
    const { events, result } = await collect(agent.stream('List my repositories.', { principal: ALICE }));
    expect(toolMessage(result)).toEqual({ repos: ['lousho-demo'], debug: 'token=[REDACTED]' });
    expect(JSON.stringify(events)).not.toContain('gho_SECRET_leaky');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Tool 'list_repos' returned an OAuth token"));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('gho_SECRET_leaky');
  });
});

describe('defineOAuthProvider (N9b)', () => {
  it('validates the name, the URLs and the client id', () => {
    const server = fakeOAuthServer();
    expect(() => githubProvider(server, { name: 'git hub' })).toThrow(/`name` must be 1-64 characters/);
    expect(() => githubProvider(server, { tokenUrl: 'not a url' })).toThrow(/`tokenUrl` must be an absolute http\(s\) URL/);
    expect(() => githubProvider(server, { redirectUri: 'javascript:alert(1)' })).toThrow(/`redirectUri`/);
    expect(() => githubProvider(server, { clientId: '' })).toThrow(/`clientId`/);
    expect(() => githubProvider(server, { credentialOwner: 'team' as 'app' })).toThrow(/`credentialOwner`/);
    expect(() => githubProvider(server, { clientAuth: 'jwt' as 'client_secret_post' })).toThrow(/`clientAuth`/);
    const provider = githubProvider(server, { authorizationParams: { prompt: 'consent', state: 'attacker' } });
    expect(Object.isFrozen(provider)).toBe(true);
    expect(provider).toMatchObject({ credentialOwner: 'user', clientAuth: 'client_secret_post' });
  });

  it('authorization params cannot replace the state, the challenge or the redirect', async () => {
    const provider = githubProvider(fakeOAuthServer(), { authorizationParams: { prompt: 'consent', state: 'attacker', redirect_uri: 'https://evil.example.com' } });
    const url = new URL(await startSignIn(provider, ALICE_OWNER, new MemoryTokenStore()));
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).not.toBe('attacker');
    expect(url.searchParams.get('redirect_uri')).toBe('https://agent.example.com/api/agent/oauth/callback');
  });
});
