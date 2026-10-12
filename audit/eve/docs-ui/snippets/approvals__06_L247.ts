// approvals.md:247
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string() }),
  needsApproval: true,
  execute: async ({ to }) => `sent to ${to}`,
});
const agent = createAgent({
  provider,
  tools: [sendEmail],
  approvalTtlMs: 5 * 60_000, // pauses die after five minutes unanswered
});
export {};
