/* Eve repro 1: mountFetchChannels without ctx.waitUntil — the early ack the
   channel writes in `parse` is not returned until the whole turn finishes.
   On a fetch host with no waitUntil (Next.js route, Bun.serve, plain Workers
   code), a Slack/Discord ack lands after the 3s deadline whenever the turn is
   slow. */
import { mountFetchChannels } from '../../../src/channels/fetchChannels';
import { defineChannel, type ChannelRespond } from '../../../src/channels/defineChannel';

const TURN_MS = 800;

// Minimal fake agent: a session whose stream takes TURN_MS then finishes.
const fakeAgent = {
  session: () => ({
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((r) => setTimeout(r, TURN_MS));
        yield { type: 'text.delta', text: 'hi' };
      },
      result: new Promise((r) => setTimeout(() => r({ text: 'hi', finishReason: 'stop' }), TURN_MS)),
    }),
    pending: async () => undefined,
    resume: async () => undefined,
  }),
  approvals: { list: async () => [], get: async () => undefined },
};

const channel = defineChannel({
  name: 'slacklike',
  async parse(_req, respond: ChannelRespond) {
    respond(200, { ok: true }); // the surface ack, sent at parse time
    return { sessionKey: 'c1', input: 'hi', replyTo: null };
  },
  async reply() {},
});

const handler = mountFetchChannels(fakeAgent as never, [channel]);

const req = () => new Request('http://h/channels/slacklike', { method: 'POST', body: '{}' });

let t0 = Date.now();
const resNoCtx = await handler(req());
console.log(`no waitUntil:  status=${resNoCtx!.status}  handler resolved in ${Date.now() - t0}ms (turn is ${TURN_MS}ms)`);

t0 = Date.now();
const resCtx = await handler(req(), { waitUntil: () => {} });
console.log(`with waitUntil: status=${resCtx!.status}  handler resolved in ${Date.now() - t0}ms`);
