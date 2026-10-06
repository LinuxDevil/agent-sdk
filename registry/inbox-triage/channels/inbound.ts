/**
 * The inbound channel (the kit's second intake, next to the poll schedule):
 * a webhook that accepts `POST /channels/inbound` with a JSON
 * `{ from, subject?, body }`, files the message into the kit's inbox store
 * and hands the agent a triage turn keyed to the sender - the sender is the
 * session key and the verified principal, so the 'senders' memory slot scopes
 * to whoever wrote in.
 *
 * Set INBOUND_TOKEN to require `Authorization: Bearer <token>`; unset, every
 * request is accepted (fine for a local demo, not for the public internet).
 * A paused turn replies 200 with the pending `approval`; decide it at
 * `POST /channels/inbound/approvals/<id>` like every channel.
 */
import { defineChannel } from '@lousho/build-ai-agent';
import { addMessage } from '../lib/mailstore';

export default defineChannel({
  name: 'inbound',
  async verify(req) {
    const expected = process.env.INBOUND_TOKEN;
    if (expected === undefined || expected === '') return true;
    return req.headers.authorization === `Bearer ${expected}`;
  },
  async parse(req) {
    const payload = JSON.parse(req.text || '{}') as { from?: unknown; subject?: unknown; body?: unknown };
    if (typeof payload.from !== 'string' || payload.from === '' || typeof payload.body !== 'string' || payload.body === '') {
      throw new SyntaxError("POST /channels/inbound wants a JSON body with 'from' and 'body' strings (optionally 'subject').");
    }
    const message = await addMessage({
      from: payload.from,
      subject: typeof payload.subject === 'string' && payload.subject !== '' ? payload.subject : '(no subject)',
      body: payload.body,
    });
    return {
      sessionKey: message.from,
      input:
        `A new message just arrived in the inbox: id ${message.id}, from ${message.from}, ` +
        `subject "${message.subject}". Triage it now: read_message, classify_message, ` +
        'recall what you know about the sender (recall_senders), draft_reply if it needs an answer ' +
        'and call send_reply once - it pauses for human review. mark_processed when done.',
      principal: { id: message.from, type: 'user', authenticator: 'inbound' },
      metadata: { sender: message.from },
      replyTo: null,
      event: { messageId: message.id },
    };
  },
  async reply({ inbound, sessionId, text, result, approval, respond }) {
    respond?.(200, { ok: true, sessionId, messageId: (inbound.event as { messageId?: string })?.messageId, text, finishReason: result?.finishReason, approval });
  },
});
