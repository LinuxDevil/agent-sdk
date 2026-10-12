/* Eve repro 4b: double-click on an approval button while `onDecision` does real
   work. decide() awaits audit() between `paused.get` and `paused.delete`, so a
   second click lands inside the window: both continue, the loser surfaces a
   "Sorry, that request failed." reply even though the approval succeeded. */
import * as http from 'node:http';
import { mountChannels } from '../../../src/channels/mountChannels';
import { defineChannel, type ChannelInbound } from '../../../src/channels/defineChannel';
import { createAgent } from '../../../src/createAgent';
import { defineTool } from '../../../src/tools/defineTool';
import { mockModel } from '../../../src/testing';
import { z } from 'zod';

const tool = defineTool({
  name: 'refund',
  description: 'refund',
  input: z.object({ id: z.string() }),
  needsApproval: true,
  execute: async () => 'done',
});
const agent = createAgent({
  provider: mockModel([{ toolCalls: [{ name: 'refund', args: { id: 'o1' } }] }, 'refunded']),
  tools: [tool],
});

const replies: string[] = [];
let pausedId = '';
const inbound: ChannelInbound = { sessionKey: 's', input: '', replyTo: null };
const channel = defineChannel({
  name: 'c',
  async parse(req) {
    const body = JSON.parse(req.text) as { text?: string; approve?: string };
    if (body.approve) return { decision: { id: body.approve, approved: true }, inbound, approver: { id: 'U1' } };
    return { sessionKey: 's', input: body.text ?? '', replyTo: null };
  },
  async reply({ approval, text, respond }) {
    respond?.(200, { ok: true });
    if (approval) pausedId = approval.id;
    else replies.push(text);
  },
});
const channels = mountChannels(agent, [channel], {
  onDecision: () => new Promise<void>((r) => setTimeout(r, 50)), // e.g. an audit-log write
});

const server = http.createServer((req, res) => void channels(req, res).then((h) => h || res.writeHead(404).end()));
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;
const post = (body: unknown) =>
  fetch(`http://localhost:${port}/channels/c`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

await post({ text: 'refund me' });
console.log('paused on:', pausedId);
const [a, b] = await Promise.all([post({ approve: pausedId }), post({ approve: pausedId })]);
await new Promise((r) => setTimeout(r, 300));
console.log('statuses:', a.status, b.status);
console.log('replies posted to the surface:', replies);
server.close();
