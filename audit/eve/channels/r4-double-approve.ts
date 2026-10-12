/* Eve repro 4: two concurrent POSTs to /channels/<name>/approvals/<id> race in
   channelCore.decide(): both pass `paused.get` before `paused.delete`, both
   resolve; the loser gets a 500 with an internal message instead of the clean
   409/404 the session API returns (decisionGate in fetchRoutes). */
import * as http from 'node:http';
import { mountChannels } from '../../../src/channels/mountChannels';
import { defineChannel } from '../../../src/channels/defineChannel';
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

const channel = defineChannel({
  name: 'c',
  async parse(req) {
    const { text } = JSON.parse(req.text) as { text: string };
    return { sessionKey: 's', input: text, replyTo: null };
  },
  async reply({ approval, respond }) {
    respond?.(200, { approvalId: approval?.id });
  },
});
const channels = mountChannels(agent, [channel]);

const server = http.createServer((req, res) => void channels(req, res).then((h) => h || res.writeHead(404).end()));
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;
const post = (path: string, body: unknown) =>
  fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const first = await (await post('/channels/c', { text: 'refund me' })).json();
console.log('paused on approval:', (first as { approvalId?: string }).approvalId);

const id = (first as { approvalId: string }).approvalId;
const [a, b] = await Promise.all([post(`/channels/c/approvals/${id}`, { approved: true }), post(`/channels/c/approvals/${id}`, { approved: true })]);
console.log('decision 1:', a.status, await a.text());
console.log('decision 2:', b.status, await b.text());
server.close();
