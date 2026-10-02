// (b) Coding agent: fs + shell tools, human approval on destructive commands.
// The run pauses on a gated call; the answer is read from stdin and the
// continued run is streamed with agent.approvals.streamResolve().
// Run: OPENAI_API_KEY=... npx tsx coding.ts "Fix the failing test"
import { createInterface } from 'node:readline/promises';
import { NodeWorkspace, createAgent, createFsTools, createShellTool } from '@lousho/build-ai-agent';

const DESTRUCTIVE = /\b(rm|mv|chmod|chown|git\s+(push|reset|clean|checkout))\b|>/;

const workspace = new NodeWorkspace({ root: process.cwd() });
const agent = createAgent({
  model: 'openai/gpt-4o-mini',
  instructions: 'You are a careful coding agent. Read before you edit; run the tests after every change.',
  maxSteps: 30,
  tools: [
    ...createFsTools(workspace, { needsApproval: { write_file: true, edit_file: true } }),
    createShellTool(workspace, { needsApproval: (command) => DESTRUCTIVE.test(command) }),
  ],
});
const rl = createInterface({ input: process.stdin, output: process.stdout });

let run = agent.stream(process.argv[2] ?? 'Run the tests and fix what fails.');
for (;;) {
  for await (const event of run) {
    if (event.type === 'text.delta') process.stdout.write(event.text);
    if (event.type === 'tool.start') console.log(`\n> ${event.toolName} ${JSON.stringify(event.args)}`);
  }
  const { approvalId } = await run.result;
  if (!approvalId) break;
  const answer = await rl.question('\nApprove this call? [y/N] ');
  run = agent.approvals.streamResolve({ id: approvalId, approved: answer.trim().toLowerCase() === 'y' });
}
process.stdout.write('\n');
rl.close();
