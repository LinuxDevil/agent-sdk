/**
 * The read side of the triage pipeline: list and read messages, record a
 * classification, mark a message handled. `delete_message` exists so the
 * permission manifest has something real to deny - the agent.json rule
 * refuses it ("triage never deletes"), which is the kit's guardrail story.
 */
import { z } from 'zod';
import { defineTool } from '@lousho/build-ai-agent';
import { getMessage, listMessages, updateMessage, type MessageStatus } from '../lib/mailstore';

const STATUS = z.enum(['new', 'triaged', 'replied', 'processed', 'trashed']);

const list = defineTool({
  name: 'list_messages',
  description:
    "List inbox messages, newest first: id, sender, subject, status and a short body snippet. 'status' filters; 'all' shows everything. Start triage with status 'new'.",
  input: z.object({
    status: STATUS.or(z.literal('all')).default('new').describe("Which messages to list; 'all' shows the whole inbox"),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false },
  async execute({ status }) {
    const messages = await listMessages(status === 'all' ? undefined : (status as MessageStatus));
    return messages.map(({ body, ...message }) => ({ ...message, snippet: body.slice(0, 160) }));
  },
});

const read = defineTool({
  name: 'read_message',
  description: 'Read one inbox message in full (the listing only shows a snippet).',
  input: z.object({ id: z.string().describe('The message id from list_messages') }),
  annotations: { readOnlyHint: true, destructiveHint: false },
  async execute({ id }) {
    return getMessage(id);
  },
});

const classify = defineTool({
  name: 'classify_message',
  description:
    "Record the triage classification of a message: 'urgent' (time-critical, reply today), 'reply-needed' (a real person expects an answer), 'fyi' (worth reading, no reply) or 'spam' (junk). Classifying moves the message to 'triaged'.",
  input: z.object({
    id: z.string().describe('The message id from list_messages'),
    category: z.enum(['urgent', 'reply-needed', 'fyi', 'spam']),
    reason: z.string().describe('One sentence on why, kept on the message for the human reviewing the triage'),
  }),
  async execute({ id, category, reason }) {
    return updateMessage(id, { category, categoryReason: reason, status: 'triaged' });
  },
});

const markProcessed = defineTool({
  name: 'mark_processed',
  description:
    "Mark a message fully handled - read, classified and (when it needed one) replied to or deliberately not answered. Processed messages leave the 'new'/'triaged' queues.",
  input: z.object({ id: z.string().describe('The message id from list_messages') }),
  async execute({ id }) {
    return updateMessage(id, { status: 'processed' });
  },
});

const del = defineTool({
  name: 'delete_message',
  description:
    "Move a message to 'trashed'. The kit's permission rules deny this - triage never deletes; classify junk as 'spam' and mark it processed instead.",
  input: z.object({ id: z.string().describe('The message id from list_messages') }),
  annotations: { destructiveHint: true },
  async execute({ id }) {
    return updateMessage(id, { status: 'trashed' });
  },
});

export default [list, read, classify, markProcessed, del];
