/**
 * N9b: the sign-in flow over HTTP - `createRouteHandler` (under a base path)
 * and `createDeployedServer` (node:http, with channels): the paused turn's
 * stream carries the link, approving early is 409, `GET .../oauth/callback`
 * answers a small HTML page outside route auth, a used or expired state is
 * 400, and approving after the callback streams the continuation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { createRouteHandler } from '../server/routeHandler';
import { createDeployedServer } from '../deploy/nodeServer';
import { defineChannel } from '../channels/defineChannel';
import { continueChannelSignIn } from '../channels/mountChannels';
import { SDKError } from '../execution/errors';
import type { AuthFn } from '../auth/types';
import type { AgentEvent, AgentEventOf } from '../execution/agentEvents';
import { ALICE, BOB, fakeOAuthServer, githubProvider, listReposTool } from './__fixtures__/fakeOAuth';

afterEach(() => { vi.restoreAllMocks(); });

const CALL = { toolCalls: [{ name: 'list_repos', id: 'call_1', args: {} }] };

/** `Bearer alice` / `Bearer bob`; anything else skips (a 401 at the end of the list). */
const auth: AuthFn = (request) => {
  const header = request.headers.get('authorization');
  return header === 'Bearer alice' ? ALICE : header === 'Bearer bob' ? BOB : null;
};

function agentWithGitHub(turns = [CALL, { text: 'You have lousho-demo and agent-sdk.' }]) {
  const server = fakeOAuthServer();
  const github = githubProvider(server);
  const { tool, executions } = listReposTool(github);
  const agent = createAgent({ provider: mockModel(turns), tools: [tool], store: memoryStore() });
  return { agent, executions };
}

async function sse(response: Response): Promise<AgentEvent[]> {
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  return (await response.text())
    .split('\n\n')
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined && line !== 'data: {}')
    .map((line) => JSON.parse(line.slice(6)) as AgentEvent);
}

function approvalOf(events: AgentEvent[]): AgentEventOf<'approval.requested'> {
  const event = events.find((e): e is AgentEventOf<'approval.requested'> => e.type === 'approval.requested');
  if (!event) throw new Error('no approval.requested');
  return event;
}

const stateOf = (url: string | undefined) => new URL(url ?? 'http://x').searchParams.get('state') ?? '';

async function expectPage(response: Response, status: number, text: string): Promise<string> {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const html = await response.text();
  expect(html).toContain(text);
  expect(html).not.toMatch(/<script/i);
  return html;
}

/** The whole HTTP flow against `call(path, init)`; `prefix` is the mount path. */
async function signInFlow(call: (path: string, init?: RequestInit) => Promise<Response>, prefix: string, executions: string[]) {
  const alice = { authorization: 'Bearer alice', 'content-type': 'application/json' };
  const turn = await sse(await call(`${prefix}/chat`, { method: 'POST', headers: alice, body: JSON.stringify({ sessionId: 's1', input: 'List my repositories.' }) }));
  const paused = approvalOf(turn);
  expect(paused).toMatchObject({ kind: 'sign-in', signIn: { provider: 'github', displayName: 'GitHub' } });
  expect(turn.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'awaiting-approval' });
  const approvals = `${prefix}/chat/s1/approvals/${paused.approvalId}`;

  // approving before the callback: 409, and the pause stays
  const early = await call(approvals, { method: 'POST', headers: alice, body: JSON.stringify({ approved: true }) });
  expect(early.status).toBe(409);
  expect(await early.json()).toMatchObject({ code: 'LOUSHO_SIGNIN_PENDING' });

  // the callback is outside route auth (no Authorization header) ...
  const state = stateOf(paused.signIn?.url);
  // ... but a request authenticated as someone else cannot complete Alice's sign-in
  await expectPage(await call(`${prefix}/oauth/callback?state=${state}&code=code-bob`, { headers: { authorization: 'Bearer bob' } }), 400, 'invalid, was already used, or expired');
  await expectPage(await call(`${prefix}/oauth/callback?state=${state}&code=code-alice`), 200, 'Signed in to GitHub. You can close this tab.');
  // a used state is 400; nothing from the query is echoed
  const reused = await expectPage(await call(`${prefix}/oauth/callback?state=${state}&code=%3Cscript%3Ealert(1)%3C%2Fscript%3E`), 400, 'invalid, was already used, or expired');
  expect(reused).not.toContain('alert(1)');

  const continued = await sse(await call(approvals, { method: 'POST', headers: alice, body: JSON.stringify({ approved: true }) }));
  expect(continued.find((e) => e.type === 'tool.done')).toMatchObject({ toolName: 'list_repos', result: { repos: ['lousho-demo', 'agent-sdk'] } });
  expect(continued.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop', text: 'You have lousho-demo and agent-sdk.' });
  expect(executions).toEqual(['gho_SECRET_alice_1']);
}

/** Bob's paused sign-in, whose callback arrives after 10 minutes: 400. */
async function expiredFlow(call: (path: string, init?: RequestInit) => Promise<Response>, prefix: string) {
  const bob = { authorization: 'Bearer bob', 'content-type': 'application/json' };
  const turn = await sse(await call(`${prefix}/chat`, { method: 'POST', headers: bob, body: JSON.stringify({ sessionId: 's2', input: 'List my repositories.' }) }));
  const state = stateOf(approvalOf(turn).signIn?.url);
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000 + 1);
  await expectPage(await call(`${prefix}/oauth/callback?state=${state}&code=code-bob`), 400, 'invalid, was already used, or expired');
}

describe('sign-in over HTTP (N9b)', () => {
  it('createRouteHandler: link in the stream, 409 before the callback, HTML callback outside auth, 400 for a used or expired state', async () => {
    const { agent, executions } = agentWithGitHub([CALL, { text: 'You have lousho-demo and agent-sdk.' }, CALL, { text: 'x' }]);
    const { handler } = createRouteHandler(agent, { basePath: '/api/agent', auth: [auth] });
    const call = (path: string, init?: RequestInit) => handler(new Request(`https://agent.example.com${path}`, init));

    // every other route is still behind auth
    expect((await call('/api/agent/chat/s1')).status).toBe(401);
    await signInFlow(call, '/api/agent', executions);
    await expiredFlow(call, '/api/agent');
    // a provider error with an unknown state is still a refused link
    expect((await call('/api/agent/oauth/callback?state=nope&error=access_denied')).status).toBe(400);
  });

  it('createDeployedServer: the same flow over node:http, under the bearer token', async () => {
    const { agent, executions } = agentWithGitHub([CALL, { text: 'You have lousho-demo and agent-sdk.' }, CALL, { text: 'x' }]);
    const { server } = createDeployedServer(agent, { auth: [auth] });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const call = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
      expect((await call('/chat/s1')).status).toBe(401);
      await signInFlow(call, '', executions);
      await expiredFlow(call, '');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('createDeployedServer with channels: after the callback, the paused channel turn continues on its surface', async () => {
    const { agent, executions } = agentWithGitHub();
    const prompts: string[] = [];
    const replies: string[] = [];
    const chat = defineChannel({
      name: 'chat',
      async parse(req) {
        const { user, text } = JSON.parse(req.text) as { user: string; text: string };
        return { sessionKey: user, input: text, replyTo: user, principal: { id: user, type: 'user', authenticator: 'jwt', issuer: 'https://id.example.com' } };
      },
      async onApproval({ text }) {
        prompts.push(text);
      },
      async reply({ text }) {
        replies.push(text);
      },
    });
    const { server } = createDeployedServer(agent, { env: { LOUSHO_API_TOKEN: 'secret' }, channels: [chat] });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/channels/chat`, { method: 'POST', body: JSON.stringify({ user: 'alice', text: 'List my repositories.' }) })).status).toBe(200);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatch(/^Sign in to GitHub to continue: https:\/\/github\.example\.com\/login\/oauth\/authorize\?/);
      const state = stateOf(prompts[0].slice(prompts[0].indexOf('https://')));

      // the callback needs no bearer token
      expect((await fetch(`${base}/oauth/callback?state=${state}&code=code-alice`)).status).toBe(200);
      await vi.waitFor(() => expect(replies).toEqual(['You have lousho-demo and agent-sdk.']));
      expect(executions).toEqual(['gho_SECRET_alice_1']);
      expect(await agent.approvals.list()).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('continueChannelSignIn (N9b)', () => {
  it('ignores a sign-in no channel turn waits on, and logs any other failure without the details of the token', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const notFound = { resolveApproval: vi.fn(() => Promise.reject(new SDKError('no turn', 'LOUSHO_APPROVAL_NOT_FOUND'))) };
    continueChannelSignIn(notFound, { approvalId: 'a1' });
    continueChannelSignIn(notFound, {});
    continueChannelSignIn(undefined, { approvalId: 'a1' });
    const broken = { resolveApproval: vi.fn(() => Promise.reject(new Error('surface down'))) };
    continueChannelSignIn(broken, { approvalId: 'a2' });
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(notFound.resolveApproval).toHaveBeenCalledTimes(1);
    expect(broken.resolveApproval).toHaveBeenCalledWith({ id: 'a2', approved: true });
    expect(error.mock.calls[0].join(' ')).toContain('surface down');
  });
});
