// streaming.md:189
import { AgentExecutor, streamResumeAfterApproval } from '@lousho/build-ai-agent/executor';

const paused = await AgentExecutor.execute({ agent, input, provider, toolRegistry, approvalStore });
const run = streamResumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, toolRegistry, provider);
for await (const event of run) {
  if (event.type === 'tool.done') console.log(`${event.toolName} ran`);
  if (event.type === 'text.delta') process.stdout.write(event.text);
}
export {};
