// approvals.md:335
import { createAgent } from '@lousho/build-ai-agent';

const agent = createAgent({ provider, tools: [emailTool] });
const paused = await agent.send('Email Sam the report');

if (paused.approvalId) {
  const run = agent.approvals.streamResolve({ id: paused.approvalId, approved: true });
  for await (const event of run) {
    if (event.type === 'text.delta') process.stdout.write(event.text);
  }
}
export {};
