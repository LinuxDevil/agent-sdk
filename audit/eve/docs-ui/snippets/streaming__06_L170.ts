// streaming.md:170
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ provider /* , a tool with needsApproval */ });
const paused = await agent.send('Delete the old reports.');
// paused.finishReason === 'awaiting-approval'
const run = agent.approvals.streamResolve({ id: paused.approvalId!, approved: true });
for await (const event of run) {
  if (event.type === 'tool.done') console.log(`${event.toolName} ran`);
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
export {};
