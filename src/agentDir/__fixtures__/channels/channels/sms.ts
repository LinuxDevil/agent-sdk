import { defineChannel } from '../../../../channels/defineChannel';

export default defineChannel({
  name: 'custom-sms',
  async parse(req) {
    const { from, body } = JSON.parse(req.text) as { from: string; body: string };
    return { sessionKey: from, input: body, replyTo: from };
  },
  async reply({ inbound, text }) {
    console.log(`to ${String(inbound.replyTo)}: ${text}`);
  },
});
