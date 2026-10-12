/* Eve repros 6 & 7: error-shape inconsistencies.
   6. A channel `parse`/`verify` that throws a non-SyntaxError before ack is
      answered 500 with the RAW internal message (mountChannels' sendFailure /
      fetchChannels' failureResponse) — while the session routes deliberately
      redact it (PUBLIC_ERROR_MESSAGE). Internal details leak to the caller.
   7. POST <base>/ui with an invalid chat id -> 500; the same id on POST /chat -> 400. */
import { mountFetchChannels } from '../../../src/channels/fetchChannels';
import { defineChannel } from '../../../src/channels/defineChannel';
import { createRouteHandler } from '../../../src/server/routeHandler';
import { createAgent } from '../../../src/createAgent';
import { mockModel } from '../../../src/testing';

const fakeAgent = {
  session: () => ({ stream: () => ({}), pending: async () => undefined }),
  approvals: { list: async () => [], get: async () => undefined },
};
const leaky = defineChannel({
  name: 'leaky',
  async verify() {
    throw new Error('connect ECONNREFUSED postgres://admin:hunter2@10.0.0.1:5432/prod');
  },
  async parse() {
    return null;
  },
  async reply() {},
});
const channels = mountFetchChannels(fakeAgent as never, [leaky]);
const res = await channels(new Request('http://h/channels/leaky', { method: 'POST', body: '{}' }));
console.log('channel 500 body:', await res?.text()); // leaks the internal error text

const { handler } = createRouteHandler(createAgent({ provider: mockModel(['hi']) }), { basePath: '/api', auth: 't', uiMessageStream: true });
const opts = { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' } };
const badChat = await handler(new Request('http://h/api/chat', { ...opts, body: JSON.stringify({ sessionId: 'bad/id!', input: 'x' }) }));
const badUi = await handler(
  new Request('http://h/api/ui', { ...opts, body: JSON.stringify({ id: 'bad/id!', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }] }) }),
);
console.log(`/chat invalid session id -> ${badChat.status}; /ui invalid id -> ${badUi.status} (body: ${(await badUi.text()).slice(0, 90)})`);
