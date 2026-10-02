/**
 * N11b: `githubChannel()` - webhook signatures, issue / pull-request / review
 * comments as sessions, replies as comments (split at 60,000 characters),
 * `/approve` and `/deny` approvals with the default "OWNER, MEMBER or
 * COLLABORATOR" rule, and a pending question across a restart. A fake GitHub
 * REST API stands in for the platform: no network.
 */
import { createHmac, generateKeyPairSync } from 'node:crypto';
import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { InMemoryApprovalStore } from '../execution/InMemoryApprovalStore';
import { MemorySessionStore } from '../session/sessionStore';
import type { Message } from '../providers';
import { mountChannels, type ChannelsHandler } from './mountChannels';
import { githubChannel } from './githubChannel';
import { durableStores } from './__fixtures__/durableStores';

const TOKEN = 'ghp_SECRET_personal_token';
const SECRET = 'webhook-secret_1';
const API = 'https://api.github.com';

interface Call {
  path: string;
  body: string;
  headers: Record<string, string>;
}

/** A fake REST API that records each POST and answers 201 like GitHub. */
function fakeGitHub(token = TOKEN) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url).startsWith(API)).toBe(true);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${token}`);
    calls.push({ path: String(url).slice(API.length), body: (JSON.parse(String(init?.body)) as { body: string }).body, headers });
    return new Response(JSON.stringify({ id: calls.length }), { status: 201 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

interface SendOptions {
  event?: string;
  signature?: string | null;
  secret?: string;
}

/** Posts `payload` to `handler`, signed like GitHub (or with `signature`; `null` omits the header). */
async function send(handler: ChannelsHandler, payload: unknown, options: SendOptions = {}) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { 'x-github-event': options.event ?? 'issue_comment' };
  if (options.signature !== null) headers['x-hub-signature-256'] = options.signature ?? sign(raw, options.secret);
  const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: 'POST', url: '/channels/github', headers });
  const res = { status: 0, json: {} as Record<string, unknown> };
  const fakeRes = {
    writeHead: (status: number) => ((res.status = status), fakeRes),
    end: (text?: string) => ((res.json = JSON.parse(text ?? '{}') as Record<string, unknown>), fakeRes),
  };
  await handler(req as unknown as http.IncomingMessage, fakeRes as unknown as http.ServerResponse);
  return res;
}

let commentId = 1000;

interface CommentOptions {
  number?: number;
  login?: string;
  type?: string;
  association?: string;
  action?: string;
  installation?: number;
}

/** An `issue_comment` payload (an issue; `pr: true` makes it a pull request). */
function issueComment(body: string, { number = 7, login = 'octocat', type = 'User', association = 'MEMBER', action = 'created', installation }: CommentOptions = {}, pr = false) {
  return {
    action,
    ...(installation === undefined ? {} : { installation: { id: installation } }),
    repository: { name: 'widgets', owner: { login: 'acme' } },
    issue: { number, ...(pr ? { pull_request: { url: 'x' } } : {}) },
    comment: { id: ++commentId, body, author_association: association, user: { login, type } },
  };
}

/** A `pull_request_review_comment` payload; `inReplyTo` makes it a reply in a thread. */
function reviewComment(body: string, inReplyTo?: number, { number = 9, login = 'octocat', type = 'User', association = 'MEMBER' }: CommentOptions = {}) {
  return {
    action: 'created',
    repository: { name: 'widgets', owner: { login: 'acme' } },
    pull_request: { number },
    comment: { id: ++commentId, body, author_association: association, user: { login, type }, ...(inReplyTo === undefined ? {} : { in_reply_to_id: inReplyTo }) },
  };
}

interface SetupOptions {
  channel?: Partial<Parameters<typeof githubChannel>[0]>;
  mount?: Parameters<typeof mountChannels>[2];
}

const emailTool = (execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`)) =>
  defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
const emailCall = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };
const ask = { toolCalls: [{ name: 'ask_question', args: { question: 'Which city?' }, id: 'call_q' }] };

function setup(responses: Parameters<typeof mockModel>[0], agentOptions: Partial<Parameters<typeof createAgent>[0]> = {}, extra: SetupOptions = {}) {
  const github = fakeGitHub();
  const model = mockModel(responses);
  const agent = createAgent({ provider: model, ...agentOptions });
  const channel = githubChannel({ webhookSecret: SECRET, botName: 'my-agent', token: TOKEN, fetch: github.fetch, ...extra.channel });
  const handler = mountChannels(agent, [channel], extra.mount);
  const userTexts = (call: number) => (model.calls[call].messages as Message[]).filter((m) => m.role === 'user').map((m) => m.content);
  return { ...github, model, userTexts, send: (payload: unknown, options?: SendOptions) => send(handler, payload, options) };
}

const text = (call: Call) => call.body.replace(/\n\n<!-- lousho:github-channel -->$/, '');
const ID = /\/approve ([0-9a-f-]{36})`/;

/** Runs a comment that pauses on `send_email` and returns the approval id from the prompt. */
async function pause(t: ReturnType<typeof setup>, options: CommentOptions = {}) {
  await t.send(issueComment('@my-agent email Sam', options));
  return ID.exec(t.calls[0].body)?.[1] as string;
}

describe('githubChannel (N11b)', () => {
  it('rejects a missing, malformed or wrong signature with 401 and runs nothing', async () => {
    const t = setup(['never']);
    const body = issueComment('@my-agent hi');
    const raw = JSON.stringify(body);

    expect((await t.send(body, { signature: null })).status).toBe(401);
    expect((await t.send(body, { signature: 'sha256=zz' })).status).toBe(401);
    expect((await t.send(body, { signature: raw })).status).toBe(401);
    expect((await t.send(body, { secret: 'other-secret' })).status).toBe(401);
    expect((await t.send(body, { signature: sign(`${raw} `) })).status).toBe(401); // signed over different bytes
    expect((await t.send(body, { signature: sign(raw).replace('sha256=', 'sha1=') })).status).toBe(401);
    expect((await t.send('not json', { signature: null })).status).toBe(401); // never parsed before it is verified

    expect(t.model.calls).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it('verifies the exact raw bytes, not re-serialized JSON', async () => {
    const t = setup(['ok']);
    const raw = JSON.stringify(issueComment('@my-agent hi'), null, 4); // pretty-printed: re-serializing would change the bytes

    expect((await t.send(raw)).status).toBe(200);

    expect(t.model.calls).toHaveLength(1);
  });

  it('configuration: exactly one of token and app, and non-empty secrets', () => {
    const base = { webhookSecret: SECRET, botName: 'my-agent' };
    expect(() => githubChannel({ ...base })).toThrow(/exactly one of 'token' and 'app'/);
    expect(() => githubChannel({ ...base, token: TOKEN, app: { appId: '1', privateKey: 'k' } })).toThrow(/exactly one/);
    expect(() => githubChannel({ ...base, app: { appId: '', privateKey: 'k' } })).toThrow(/app\.appId/);
    expect(() => githubChannel({ webhookSecret: '', botName: 'my-agent', token: TOKEN })).toThrow(/webhookSecret/);
    expect(() => githubChannel({ webhookSecret: SECRET, botName: '', token: TOKEN })).toThrow(/botName/);
    expect(() => githubChannel({ ...base, token: TOKEN })).not.toThrow();
  });

  it('acknowledges a ping without a turn', async () => {
    const t = setup(['never']);

    expect(await t.send({ zen: 'Keep it logically awesome.', hook_id: 1 }, { event: 'ping' })).toEqual({ status: 200, json: { ok: true } });

    expect(t.model.calls).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it('an issue comment with @my-agent runs a turn, strips the token and posts to the issue', async () => {
    const t = setup(['Hi octocat', 'You asked about widgets']);

    expect(await t.send(issueComment('@my-agent what are widgets?'))).toEqual({ status: 200, json: { ok: true } });
    await t.send(issueComment('hey @MY-AGENT and the second?'));

    expect(t.calls.map((c) => [c.path, text(c)])).toEqual([
      ['/repos/acme/widgets/issues/7/comments', 'Hi octocat'],
      ['/repos/acme/widgets/issues/7/comments', 'You asked about widgets'],
    ]);
    expect(t.userTexts(0)).toEqual(['what are widgets?']);
    expect(t.userTexts(1)[1]).toMatch(/^hey\s+and the second\?$/);
    expect(t.calls[0].headers).toMatchObject({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'lousho' });
  });

  it('the mention must be a whole token', async () => {
    const t = setup(['never']);

    await t.send(issueComment('@my-agentx hello'));
    await t.send(issueComment('mail me at x@my-agent.com'));
    await t.send(issueComment('@my-agent-two hi'));
    await t.send(issueComment('no mention here'));
    await t.send(issueComment('@my-agent')); // nothing left to say

    expect(t.model.calls).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it('a pull-request timeline comment is a turn and posts to /issues/{n}/comments', async () => {
    const t = setup(['Looks fine']);

    await t.send(issueComment('@my-agent review this', { number: 12 }, true));

    expect(t.calls.map((c) => [c.path, text(c)])).toEqual([['/repos/acme/widgets/issues/12/comments', 'Looks fine']]);
  });

  it('the same number in another repository is another session', async () => {
    const t = setup(['one', 'two']);
    const other = issueComment('@my-agent hi', { number: 7 });
    other.repository = { name: 'gadgets', owner: { login: 'acme' } };

    await t.send(issueComment('@my-agent hi', { number: 7 }));
    await t.send(other);

    expect(t.calls.map((c) => c.path)).toEqual(['/repos/acme/widgets/issues/7/comments', '/repos/acme/gadgets/issues/7/comments']);
    expect(t.userTexts(1)).toEqual(['hi']);
  });

  it('a review comment replies under the thread, and two review threads are two sessions', async () => {
    const t = setup(['first thread', 'second thread', 'first again']);
    const a = reviewComment('@my-agent explain this line');
    const aId = a.comment.id;
    const b = reviewComment('@my-agent and this one');

    const review = { event: 'pull_request_review_comment' };
    await t.send(a, review);
    await t.send(b, review);
    await t.send(reviewComment('and why?', aId), review); // a reply in thread A: a follow-up without a mention

    expect(t.calls.map((c) => [c.path, text(c)])).toEqual([
      [`/repos/acme/widgets/pulls/9/comments/${aId}/replies`, 'first thread'],
      [`/repos/acme/widgets/pulls/9/comments/${b.comment.id}/replies`, 'second thread'],
      [`/repos/acme/widgets/pulls/9/comments/${aId}/replies`, 'first again'],
    ]);
    expect(t.userTexts(1)).toEqual(['and this one']);
    expect(t.userTexts(2)).toEqual(['explain this line', 'and why?']);
  });

  it('a follow-up in a thread that has a session runs without a mention; one without a session does not', async () => {
    const t = setup(['first', 'second']);

    await t.send(issueComment('and this thread, no mention', { number: 8 }));
    expect(t.model.calls).toHaveLength(0);

    await t.send(issueComment('@my-agent start'));
    await t.send(issueComment('no mention needed now'));

    expect(t.userTexts(1)).toEqual(['start', 'no mention needed now']);
    expect(t.calls).toHaveLength(2);
  });

  it('ignores bot comments, its own account, edits, deletions and other events', async () => {
    const t = setup(['never']);

    await t.send(issueComment('@my-agent hi', { login: 'dependabot[bot]', type: 'Bot' }));
    await t.send(issueComment('@my-agent hi', { login: 'my-agent[bot]', type: 'User' }));
    await t.send(issueComment('@my-agent hi', { login: 'My-Agent', type: 'User' }));
    await t.send(issueComment('@my-agent hi', { action: 'edited' }));
    await t.send(issueComment('@my-agent hi', { action: 'deleted' }));
    await t.send(reviewComment('@my-agent hi', undefined, { type: 'Bot' }), { event: 'pull_request_review_comment' });
    await t.send({ action: 'opened', issue: { number: 1 }, repository: { name: 'w', owner: { login: 'acme' } } }, { event: 'issues' });
    await t.send(issueComment('@my-agent hi'), { event: 'pull_request' });
    await t.send({ action: 'created', repository: { name: 'w', owner: { login: 'acme' } } });
    await t.send(issueComment('@my-agent hi\n\n<!-- lousho:github-channel -->')); // carries the channel's own marker

    expect(t.model.calls).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it('botLogin names the account a personal access token posts as, so its comments never start a turn', async () => {
    const t = setup(['never'], {}, { channel: { botLogin: 'agent-owner' } });

    await t.send(issueComment('@my-agent I said hi', { login: 'Agent-Owner' }));

    expect(t.model.calls).toHaveLength(0);
  });

  it('a reply that contains the mention is not a loop: every posted comment carries a marker and is ignored when it comes back', async () => {
    const t = setup(['You said @my-agent, so here I am']);

    await t.send(issueComment('@my-agent hello'));
    const posted = t.calls[0].body;
    expect(posted).toContain('@my-agent');
    await t.send(issueComment(posted, { login: 'someone-using-the-same-pat' }));

    expect(t.model.calls).toHaveLength(1);
    expect(t.calls).toHaveLength(1);
  });

  it('triggers: a list or a function decides who may start a turn; comments by anyone else are ignored', async () => {
    const list = setup(['for octocat'], {}, { channel: { triggers: ['OctoCat'] } });
    await list.send(issueComment('@my-agent hi', { login: 'mallory', association: 'NONE' }));
    await list.send(issueComment('@my-agent hi', { login: 'octocat' }));
    await list.send(issueComment('a follow-up', { login: 'mallory', association: 'NONE' }));
    expect(list.model.calls).toHaveLength(1);

    const fn = setup(['for members'], {}, { channel: { triggers: (who) => ['OWNER', 'MEMBER'].includes(who.association) } });
    await fn.send(issueComment('@my-agent hi', { association: 'NONE' }));
    await fn.send(issueComment('@my-agent hi', { association: 'OWNER' }));
    expect(fn.model.calls).toHaveLength(1);
  });

  it('splits a 130,000-character reply into 3 comments of at most 60,000 characters at line breaks', async () => {
    const long = `${'a'.repeat(50_000)}\n${'b'.repeat(50_000)}\n${'c'.repeat(30_000)}`;
    const t = setup([long]);

    await t.send(issueComment('@my-agent write a lot'));

    expect(t.calls).toHaveLength(3);
    expect(t.calls.every((c) => c.path === '/repos/acme/widgets/issues/7/comments')).toBe(true);
    expect(t.calls.every((c) => text(c).length <= 60_000 && c.body.length <= 65_536)).toBe(true);
    expect(t.calls.map(text).join('\n')).toBe(long);
  });

  describe('approvals', () => {
    it('posts the prompt, and /approve <id> by a MEMBER resumes the session and the reply says who approved', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const onDecision = vi.fn();
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { mount: { onDecision } });

      await t.send(issueComment('@my-agent email Sam'));

      const prompt = t.calls[0].body;
      const id = ID.exec(prompt)?.[1] as string;
      expect(prompt).toContain('`send_email`');
      expect(prompt).toContain('```json\n{\n  "to": "sam@example.com"\n}\n```');
      expect(prompt).toContain(`Reply \`/approve ${id}\` or \`/deny ${id}\`.`);
      expect(execute).not.toHaveBeenCalled();

      await t.send(issueComment(`/approve ${id}`, { login: 'maintainer', association: 'MEMBER' }));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(t.calls.slice(1).map((c) => [c.path, text(c)])).toEqual([
        ['/repos/acme/widgets/issues/7/comments', 'Approved by @maintainer.'],
        ['/repos/acme/widgets/issues/7/comments', 'Email sent.'],
      ]);
      expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ approver: { id: 'maintainer', name: 'maintainer', roles: ['MEMBER'] }, channel: 'github' }));
    });

    it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('%s may approve by default (command in any case)', async (association) => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Done.'], { tools: [emailTool(execute)] });
      const id = await pause(t);

      await t.send(issueComment(`/APPROVE ${id}`, { login: 'someone', association }));

      expect(execute).toHaveBeenCalledTimes(1);
    });

    it.each(['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN'])('%s is refused by default and the approval stays pending', async (association) => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
      const id = await pause(t);

      await t.send(issueComment(`/approve ${id}`, { login: 'mallory', association }));

      expect(t.calls.slice(1).map(text)).toEqual(['@mallory is not allowed to approve this request.']);
      expect(execute).not.toHaveBeenCalled();
      await t.send(issueComment(`/approve ${id}`, { login: 'maintainer', association: 'OWNER' }));
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('the author of the request is not special: a NONE who wrote it cannot approve it', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall], { tools: [emailTool(execute)] });
      const id = await pause(t, { login: 'mallory', association: 'NONE' });

      await t.send(issueComment(`/approve ${id}`, { login: 'mallory', association: 'NONE' }));

      expect(execute).not.toHaveBeenCalled();
    });

    it('only the first line decides: a quote of the prompt or the command in the middle of a comment does nothing', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const onError = vi.fn(); // the comments below are follow-ups of a session that waits on the approval: they decide nothing
      const t = setup([emailCall], { tools: [emailTool(execute)] }, { channel: { onError } });
      const id = await pause(t);

      await t.send(issueComment(`> Reply \`/approve ${id}\` or \`/deny ${id}\`.\n\nI think we should`));
      await t.send(issueComment(`please /approve ${id}`));
      await t.send(issueComment(`Reply \`/approve ${id}\``));
      await t.send(issueComment(`/approve ${id} and more words`));

      expect(execute).not.toHaveBeenCalled();
      expect(t.calls.some((c) => /Approved|Denied/.test(c.body))).toBe(false);
    });

    it('approvers as a list of logins overrides the default (case-insensitive), in both directions', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { channel: { approvers: ['OctoCat'] } });
      const id = await pause(t);

      await t.send(issueComment(`/approve ${id}`, { login: 'maintainer', association: 'OWNER' })); // OWNER, but not listed
      expect(execute).not.toHaveBeenCalled();
      expect(t.calls[1].body).toContain('@maintainer is not allowed');

      await t.send(issueComment(`/approve ${id}`, { login: 'octocat', association: 'NONE' })); // listed, any association
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('approvers as a function sees the login, the association and the pending call', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const approvers = vi.fn((user: { id: string; roles?: string[] }, request: { toolName: string }) => user.roles?.includes('OWNER') === true && request.toolName === 'send_email');
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] }, { channel: { approvers } });
      const id = await pause(t);

      await t.send(issueComment(`/approve ${id}`, { login: 'member', association: 'MEMBER' }));
      expect(execute).not.toHaveBeenCalled();
      await t.send(issueComment(`/approve ${id}`, { login: 'Boss', association: 'OWNER' }));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(approvers).toHaveBeenLastCalledWith({ id: 'Boss', name: 'Boss', roles: ['OWNER'] }, expect.objectContaining({ toolName: 'send_email', input: { to: 'sam@example.com' } }));
    });

    it('the association is read from the command comment, so a user who lost membership is refused on the next command', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
      const id = await pause(t, { login: 'u', association: 'MEMBER' }); // U could have approved when the prompt was posted

      await t.send(issueComment(`/approve ${id}`, { login: 'u', association: 'NONE' })); // U was removed: GitHub now reports NONE

      expect(execute).not.toHaveBeenCalled();
    });

    it('/deny <id> with a note declines the call and passes the note to the model', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Okay, not sent.'], { tools: [emailTool(execute)] });
      const id = await pause(t);

      await t.send(issueComment(`/deny ${id}\nWrong recipient, ask again.`, { login: 'maintainer', association: 'OWNER' }));

      expect(execute).not.toHaveBeenCalled();
      expect(t.calls.slice(1).map(text)).toEqual(['Denied by @maintainer.', 'Okay, not sent.']);
      expect(JSON.stringify(t.model.calls[1].messages)).toContain('Wrong recipient, ask again.');
    });

    it('an already decided id (a redelivery, a second approver) decides nothing and posts nothing', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'First sent.'], { tools: [emailTool(execute)] });
      const id = await pause(t);

      await t.send(issueComment(`/approve ${id}`));
      const posts = t.calls.length;
      await t.send(issueComment(`/approve ${id}`)); // GitHub's "Redeliver" button
      await t.send(issueComment(`/deny ${id}`, { login: 'other', association: 'OWNER' }));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(t.calls).toHaveLength(posts);
    });

    it('a made-up id gets no reply from the bot for a commenter who may not approve; for one who may, it fails on the unknown approval', async () => {
      const onError = vi.fn();
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall], { tools: [emailTool(execute)] }, { channel: { onError } });
      await pause(t);
      const posts = t.calls.length;

      await t.send(issueComment('/approve 00000000-0000-0000-0000-000000000000', { login: 'mallory', association: 'NONE' }));
      expect(t.calls).toHaveLength(posts);
      expect(onError).not.toHaveBeenCalled();

      await t.send(issueComment('/approve 00000000-0000-0000-0000-000000000000', { login: 'maintainer', association: 'OWNER' }));
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'LOUSHO_APPROVAL_NOT_FOUND' }), expect.objectContaining({ stage: 'approval' }));
      expect(execute).not.toHaveBeenCalled();
    });

    it('a replayed /approve does not decide a later approval', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'First sent.', emailCall, 'Second sent.'], { tools: [emailTool(execute)] });
      const first = await pause(t);
      await t.send(issueComment(`/approve ${first}`));
      await t.send(issueComment('@my-agent email Sam again'));
      const second = ID.exec(t.calls.at(-1)?.body ?? '')?.[1] as string;
      expect(second).not.toBe(first);
      expect(execute).toHaveBeenCalledTimes(1);

      await t.send(issueComment(`/approve ${first}`)); // the old command again

      expect(execute).toHaveBeenCalledTimes(1);
      await t.send(issueComment(`/approve ${second}`));
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('an approval id from another thread cannot be decided in this one', async () => {
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const t = setup([emailCall, 'Email sent.'], { tools: [emailTool(execute)] });
      const id = await pause(t, { number: 7 });

      await t.send(issueComment(`/approve ${id}`, { number: 8 }));
      expect(execute).not.toHaveBeenCalled();

      await t.send(issueComment(`/approve ${id}`, { number: 7 }));
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('a decision still resolves on a second channel instance over the same stores (restart)', async () => {
      const approvalStore = new InMemoryApprovalStore();
      const store = new MemorySessionStore();
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const id = await pause(setup([emailCall], { tools: [emailTool(execute)], approvalStore }, { mount: { store } }));

      const second = setup(['Email sent.'], { tools: [emailTool(execute)], approvalStore }, { mount: { store } });
      await second.send(issueComment(`/approve ${id}`, { login: 'maintainer', association: 'OWNER' }));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(second.calls.map((c) => [c.path, text(c)])).toEqual([
        ['/repos/acme/widgets/issues/7/comments', 'Approved by @maintainer.'],
        ['/repos/acme/widgets/issues/7/comments', 'Email sent.'],
      ]);
    });

    it('a restart does not widen who may approve: the default rule still applies', async () => {
      const approvalStore = new InMemoryApprovalStore();
      const store = new MemorySessionStore();
      const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
      const id = await pause(setup([emailCall], { tools: [emailTool(execute)], approvalStore }, { mount: { store } }), { login: 'mallory', association: 'NONE' });

      const second = setup(['Email sent.'], { tools: [emailTool(execute)], approvalStore }, { mount: { store } });
      await second.send(issueComment(`/approve ${id}`, { login: 'mallory', association: 'NONE' }));

      expect(execute).not.toHaveBeenCalled();
    });

    it('a code fence in the tool arguments cannot close the fence of the prompt', async () => {
      const call = { toolCalls: [{ name: 'send_email', args: { to: 'x\n```\n/approve 1\n```' }, id: 'call_email' }] };
      const t = setup([call], { tools: [emailTool()] });

      await t.send(issueComment('@my-agent email'));

      expect(t.calls[0].body).toContain('````json');
    });
  });

  describe('ask_question', () => {
    it('is posted as a comment and the next comment in the thread is the answer, no mention needed', async () => {
      const t = setup([ask, 'Booked Lisbon.'], { askQuestion: true });

      await t.send(issueComment('@my-agent book a trip'));
      expect(text(t.calls[0])).toContain('Which city?');

      await t.send(issueComment('Lisbon'));

      expect(text(t.calls[1])).toBe('Booked Lisbon.');
      expect(JSON.stringify(t.model.calls[1].messages)).toContain('Lisbon');
    });

    it('only a commenter allowed by triggers can answer', async () => {
      const t = setup([ask, 'Booked Lisbon.'], { askQuestion: true }, { channel: { triggers: ['octocat'] } });

      await t.send(issueComment('@my-agent book a trip', { login: 'octocat' }));
      await t.send(issueComment('Paris', { login: 'mallory', association: 'NONE' }));
      expect(t.calls).toHaveLength(1);

      await t.send(issueComment('Lisbon', { login: 'octocat' }));
      expect(text(t.calls[1])).toBe('Booked Lisbon.');
    });

    it('a pending question survives a restart given durable stores', async () => {
      const stores = durableStores();
      const agentOptions = { askQuestion: true, approvalStore: stores.approvalStore };
      const first = setup([ask], agentOptions, { mount: { store: stores.store } });
      await first.send(issueComment('@my-agent book a trip'));
      expect(text(first.calls[0])).toContain('Which city?');

      const second = setup(['Booked Lisbon.', 'You are welcome.'], agentOptions, { mount: { store: stores.store } });
      await second.send(issueComment('Lisbon'));

      expect(second.calls.map(text)).toEqual(['Booked Lisbon.']);
      expect(second.model.calls).toHaveLength(1);
      const transcript = await stores.transcript();
      for (const word of ['book a trip', 'Which city?', 'Lisbon', 'Booked Lisbon.']) expect(transcript).toContain(word);

      await second.send(issueComment('Thanks'));
      expect(second.calls.map(text)).toEqual(['Booked Lisbon.', 'You are welcome.']);
      expect(second.userTexts(1)).toEqual(['book a trip', 'Thanks']);
    });
  });

  describe('GitHub App authentication', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

    it('fetches an installation token for the event installation, once, and posts with it', async () => {
      const calls: Array<{ path: string; authorization: string }> = [];
      const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = String(url).slice(API.length);
        calls.push({ path, authorization: String((init?.headers as Record<string, string>).authorization) });
        return path.startsWith('/app/installations/')
          ? new Response(JSON.stringify({ token: 'ghs_install', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 })
          : new Response('{}', { status: 201 });
      }) as unknown as typeof globalThis.fetch;
      const t = setup(['one', 'two'], {}, { channel: { token: undefined, app: { appId: '12345', privateKey: pem }, fetch } });

      await t.send(issueComment('@my-agent hi', { installation: 777 }));
      await t.send(issueComment('and again', { installation: 777 }));

      expect(calls.map((c) => c.path)).toEqual(['/app/installations/777/access_tokens', '/repos/acme/widgets/issues/7/comments', '/repos/acme/widgets/issues/7/comments']);
      expect(calls[0].authorization).toMatch(/^Bearer eyJ/);
      expect(calls[1].authorization).toBe('Bearer ghs_install');
    });

    it('a webhook without an installation id fails the reply to onError', async () => {
      const onError = vi.fn();
      const t = setup(['hi'], {}, { channel: { token: undefined, app: { appId: '1', privateKey: pem }, onError } });

      await t.send(issueComment('@my-agent hi'));

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('no installation id') }), expect.objectContaining({ stage: 'reply' }));
    });
  });

  it('token as a function is called for each reply', async () => {
    const token = vi.fn(async () => TOKEN);
    const t = setup(['one', 'two'], {}, { channel: { token } });

    await t.send(issueComment('@my-agent hi'));
    await t.send(issueComment('again'));

    expect(token).toHaveBeenCalledTimes(2);
  });

  it('apiUrl points the REST calls at GitHub Enterprise', async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (url: RequestInfo | URL) => (urls.push(String(url)), new Response('{}', { status: 201 }))) as unknown as typeof globalThis.fetch;
    const t = setup(['ok'], {}, { channel: { apiUrl: 'https://ghe.example.com/api/v3/', fetch } });

    await t.send(issueComment('@my-agent hi'));

    expect(urls).toEqual(['https://ghe.example.com/api/v3/repos/acme/widgets/issues/7/comments']);
  });

  describe('errors', () => {
    it('a failed post goes to onError with the call and status, and the token is not in the message', async () => {
      const onError = vi.fn();
      const failing = vi.fn(async () => new Response(JSON.stringify({ message: `Bad credentials ${TOKEN}` }), { status: 403 })) as unknown as typeof globalThis.fetch;
      const t = setup(['Hello'], {}, { channel: { onError, fetch: failing } });

      expect((await t.send(issueComment('@my-agent hi'))).json).toEqual({ ok: true });

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'LOUSHO_CHANNEL_REQUEST_FAILED', message: expect.stringContaining('POST /repos/acme/widgets/issues/7/comments failed: 403') }),
        { channel: 'github', stage: 'reply', sessionId: expect.stringContaining('github') }
      );
      const error = onError.mock.calls[0][0] as Error;
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('SECRET_personal');
    });

    it('a network error whose message carries the request does not leak the token', async () => {
      const onError = vi.fn();
      const throwing = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        throw new Error(`connect ECONNREFUSED ${JSON.stringify(init?.headers)}`);
      }) as unknown as typeof globalThis.fetch;
      const t = setup(['Hello'], {}, { channel: { onError, fetch: throwing } });

      await t.send(issueComment('@my-agent hi'));

      const error = onError.mock.calls[0][0] as Error;
      expect(error.message).toContain('POST /repos/acme/widgets/issues/7/comments');
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('SECRET_personal');
    });

    it('a token function that throws a secret does not leak it', async () => {
      const onError = vi.fn();
      const token = vi.fn(async () => {
        throw new Error('vault said ghp_leaky');
      });
      const t = setup(['Hello'], {}, { channel: { onError, token } });

      await t.send(issueComment('@my-agent hi'));

      const error = onError.mock.calls[0][0] as Error;
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('ghp_leaky');
    });

    it('the default error report never prints the token', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const failing = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof globalThis.fetch;
      const t = setup(['Hello'], {}, { channel: { fetch: failing } });

      await t.send(issueComment('@my-agent hi'));

      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.flat().join(' ')).not.toContain('SECRET_personal');
      spy.mockRestore();
    });

    it('a failed turn goes to onError and the thread is told', async () => {
      const onError = vi.fn();
      const t = setup([{ error: new Error('model down') }], {}, { channel: { onError } });

      await t.send(issueComment('@my-agent hi'));

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'model down' }), { channel: 'github', stage: 'turn', sessionId: expect.stringContaining('github') });
      expect(t.calls.map(text)).toEqual(['Sorry, that request failed.']);
    });
  });
});
