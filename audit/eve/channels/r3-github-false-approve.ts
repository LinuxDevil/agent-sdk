/* Eve repro 3: githubChannel posts "Approved by @x" (and removes nothing)
   BEFORE channelCore validates the decision. A `/approve` for an id that is
   not pending in this thread (stale, made-up, or after a restart with
   in-memory stores) produces both a false confirmation and a failure comment. */
import { createHmac } from 'node:crypto';
import { mountFetchChannels } from '../../../src/channels/fetchChannels';
import { githubChannel } from '../../../src/channels/githubChannel';
import { createAgent } from '../../../src/createAgent';
import { mockModel } from '../../../src/testing';

const posted: string[] = [];
const fakeFetch = (async (_url: unknown, init?: { body?: string }) => {
  posted.push((JSON.parse(init?.body ?? '{}') as { body?: string }).body ?? '');
  return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const agent = createAgent({ provider: mockModel(['unused']) });
const SECRET = 'whsec';
const handler = mountFetchChannels(agent, [
  githubChannel({ webhookSecret: SECRET, botName: 'my-agent', token: 'ghp_x', fetch: fakeFetch }),
]);

const payload = {
  action: 'created',
  repository: { name: 'repo', owner: { login: 'org' } },
  issue: { number: 7 },
  comment: { id: 42, body: '/approve appr_notreal', author_association: 'OWNER', user: { login: 'alice', type: 'User' } },
  installation: { id: 1 },
};
const body = JSON.stringify(payload);
const sig = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
const res = await handler(
  new Request('http://h/channels/github', {
    method: 'POST',
    headers: { 'x-hub-signature-256': sig, 'x-github-event': 'issue_comment' },
    body,
  }),
  { waitUntil: (p) => void p.catch(() => {}) },
);
// give the background turn a tick to run the refused decision + failure reply
await new Promise((r) => setTimeout(r, 300));
console.log('webhook status:', res?.status);
console.log('comments posted:', posted);
