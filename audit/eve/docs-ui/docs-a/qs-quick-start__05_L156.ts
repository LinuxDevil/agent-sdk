// quick-start.md:156
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string() }),
  needsApproval: true,
  execute: async ({ to }) => `sent to ${to}`,
});

const agent = createAgent({
  instructions: 'You send emails.',
  provider: mockModel([
    { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' } }] },
    { text: 'Sent.' },
  ]),
  tools: [sendEmail],
});

const paused = await agent.send('Email the report to sam@example.com');
console.log(paused.finishReason); // "awaiting-approval"

const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
console.log(result.text); // "Sent."
export {};
