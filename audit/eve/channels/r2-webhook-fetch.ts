/* Eve repro 2: webhookChannel under mountFetchChannels. Its verify passes
   `req.native` (a Fetch Request) to checkWebhookAuth, which reads headers with
   node-style indexing (`req.headers['x-signature-256']`) — undefined on a
   `Headers` object — so every authenticated request fails with 401. */
import { createHmac } from 'node:crypto';
import { mountFetchChannels } from '../../../src/channels/fetchChannels';
import { webhookChannel } from '../../../src/channels/webhookChannel';

const fakeAgent = {
  session: () => ({
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text.delta', text: 'ok' };
      },
      result: Promise.resolve({ text: 'ok', finishReason: 'stop' }),
    }),
    pending: async () => undefined,
    resume: async () => undefined,
  }),
  approvals: { list: async () => [], get: async () => undefined },
};

const SECRET = 'shh';
const handler = mountFetchChannels(fakeAgent as never, [webhookChannel({ secret: SECRET })]);

const body = JSON.stringify({ input: 'hi', sessionKey: 's1' });
const sig = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
const res = await handler(
  new Request('http://h/channels/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature-256': sig },
    body,
  }),
  { waitUntil: () => {} },
);
console.log(`correctly-signed webhook via mountFetchChannels: ${res?.status}`, await res?.json());
