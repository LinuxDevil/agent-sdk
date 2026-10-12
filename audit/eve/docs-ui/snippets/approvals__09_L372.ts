// approvals.md:372
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ prompt: 'Plan the trip with the user.', provider, askQuestion: true });

const paused = await agent.send('Book me a weekend away');
const [pending] = await agent.approvals.list();
if (paused.approvalId && pending?.kind === 'question') {
  console.log(pending.question?.text, pending.question?.options);
  const result = await agent.approvals.answer({ id: paused.approvalId, answer: 'Lisbon' });
  console.log(result.text);
}

// Scripted: answer every question in code.
const scripted = createAgent({
  provider,
  askQuestion: true,
  approve: (request) => (request.kind === 'question' ? 'Lisbon' : false),
});
export {};
