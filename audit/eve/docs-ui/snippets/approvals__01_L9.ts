// approvals.md:9
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string() }),
  needsApproval: true,
  execute: async ({ to }) => `sent to ${to}`,
});
const agent = createAgent({ provider, instructions: 'You send emails.', tools: [sendEmail] });

const paused = await agent.send('Email the report to sam@example.com');
if (paused.finishReason === 'awaiting-approval') {
  console.log(await agent.approvals.list()); // [{ id, toolName: 'send_email', args: { to: '...' }, ... }]
  const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true }); // or approved: false, note: 'why'
  console.log(result.text);
}
export {};
