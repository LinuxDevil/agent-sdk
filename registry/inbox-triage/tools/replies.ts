/**
 * The write side of the triage pipeline: drafts, then the one externally
 * visible action - `send_reply`. `send_reply` carries `needsApproval` in the
 * tool itself AND an `ask` permission rule in agent.json: either way, the run
 * pauses and a human decides before anything lands in the outbox.
 */
import { z } from 'zod';
import { defineTool } from '@lousho/build-ai-agent';
import { appendOutbox, findDraft, getMessage, listDrafts, addDraft, updateDraft, updateMessage } from '../lib/mailstore';

const list = defineTool({
  name: 'list_drafts',
  description: 'List reply drafts, optionally for one message. Use it to find the draft to pass to send_reply.',
  input: z.object({ messageId: z.string().optional().describe('Only drafts replying to this message') }),
  annotations: { readOnlyHint: true, destructiveHint: false },
  async execute({ messageId }) {
    return listDrafts(messageId);
  },
});

const draft = defineTool({
  name: 'draft_reply',
  description:
    "Write a reply draft to a message: it is saved for human review, nothing is sent. The recipient and 'Re:' subject come from the message; pass 'subject' only to override. Write the final text - no [placeholders]; a hook refuses half-written drafts at send time.",
  input: z.object({
    messageId: z.string().describe('The message id being replied to'),
    body: z.string().describe('The full reply body, ready to send as-is'),
    subject: z.string().optional().describe("Defaults to 'Re: <original subject>'"),
  }),
  async execute({ messageId, body, subject }) {
    const message = await getMessage(messageId);
    return addDraft({ messageId, to: message.from, subject: subject ?? `Re: ${message.subject}`, body });
  },
});

const send = defineTool({
  name: 'send_reply',
  description:
    'Send a reply: the draft (draftId) or an inline body lands in the outbox and the message is marked replied. Every call pauses for human approval - call it once, with the final text, after the human has had a chance to review the draft.',
  input: z
    .object({
      messageId: z.string().describe('The message id being replied to'),
      draftId: z.string().optional().describe('A draft from draft_reply to send as-is'),
      body: z.string().optional().describe('An inline reply body when there is no draft'),
      subject: z.string().optional().describe('Subject for an inline reply; defaults to the draft\'s or "Re: <original>"'),
    })
    .refine((args) => (args.draftId !== undefined) !== (args.body !== undefined), {
      message: "pass exactly one of 'draftId' (send the reviewed draft) or 'body' (inline reply)",
    }),
  needsApproval: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  async execute({ messageId, draftId, body, subject }) {
    const message = await getMessage(messageId);
    const draftBody = draftId === undefined ? undefined : await findDraft(draftId);
    if (draftId !== undefined && (draftBody === undefined || draftBody.messageId !== messageId)) {
      throw new Error(`no draft '${draftId}' for message '${messageId}' - call list_drafts for the current draft ids`);
    }
    if (draftBody?.status === 'sent') throw new Error(`draft '${draftId}' was already sent`);
    const entry = await appendOutbox({
      messageId,
      ...(draftId !== undefined && { draftId }),
      to: draftBody?.to ?? message.from,
      subject: subject ?? draftBody?.subject ?? `Re: ${message.subject}`,
      body: draftBody?.body ?? (body as string),
    });
    if (draftBody) await updateDraft(draftBody.id, { status: 'sent' });
    await updateMessage(messageId, { status: 'replied' });
    return { sent: true, outboxId: entry.id, to: entry.to, subject: entry.subject };
  },
});

export default [list, draft, send];
