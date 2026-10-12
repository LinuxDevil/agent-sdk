// streaming.md:364
import { AgentExecutor } from '@lousho/build-ai-agent/executor';

const run = AgentExecutor.stream({ agent, input, provider, toolRegistry, approvalStore });
for await (const event of run) {
  if (event.type === 'approval.requested') {
    console.log(`Approve ${event.toolName}(${JSON.stringify(event.args)})? id=${event.approvalId}`);
  }
}
const paused = await run.result; // paused.finishReason === 'awaiting-approval'
export {};
