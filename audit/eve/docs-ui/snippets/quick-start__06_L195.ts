// quick-start.md:195
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

let sent: string | undefined;
const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string() }),
  needsApproval: true,
  execute: async ({ to }) => {
    sent = to;
    return `sent to ${to}`;
  },
});

const model = mockModel([
  { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' } }] },
  { text: 'Sent.' },
]);
const agent = createAgent({ instructions: 'You send emails.', provider: model, tools: [sendEmail] });

const paused = await agent.send('Email the report to sam@example.com');
const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`Assertion failed: ${message}`);
}
check(result.text === 'Sent.', 'final answer');
check(sent === 'sam@example.com', 'the tool ran with the approved arguments');
check(model.calls.length === 2, 'the model was called twice');
model.assertExhausted(); // throws if a scripted turn was never used
console.log('ok');
export {};
