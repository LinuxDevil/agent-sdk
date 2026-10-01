// (b) Coding agent: fs + shell tools, human approval on destructive commands.
// createAgent() has no approval store (LOU-D21 open), so a tool that needs
// approval makes a createAgent() run throw (docs/workspace-tools.md). This
// therefore drops to AgentBuilder + AgentExecutor + an ApprovalStore +
// resumeAfterApproval().
// Run: OPENAI_API_KEY=... npx tsx coding.ts "Fix the failing test"
import { createInterface } from 'node:readline/promises';
import {
  AgentBuilder,
  AgentExecutor,
  AgentType,
  NodeWorkspace,
  ToolRegistry,
  createFsTools,
  createShellTool,
  resolveProvider,
  resumeAfterApproval,
  type ExecutionResult,
} from '@loushy/build-ai-agent';
import { SqliteStore } from '@loushy/build-ai-agent/sqlite';

const DESTRUCTIVE = /\b(rm|mv|chmod|chown|git\s+(push|reset|clean|checkout))\b|>/;

const workspace = new NodeWorkspace({ root: process.cwd() });
const tools = [
  ...createFsTools(workspace, { needsApproval: { write_file: true, edit_file: true } }),
  createShellTool(workspace, { needsApproval: (command) => DESTRUCTIVE.test(command) }),
];
const toolRegistry = new ToolRegistry();
toolRegistry.registerMany(tools);

const builder = AgentBuilder.create()
  .setType(AgentType.SmartAssistant)
  .setName('coder')
  .setPrompt('You are a careful coding agent. Read before you edit; run the tests after every change.');
for (const tool of tools) builder.addTool(tool);
const agent = builder.build();

const provider = resolveProvider('openai/gpt-4o-mini');
const approvalStore = new SqliteStore(':memory:').approvals;
const rl = createInterface({ input: process.stdin, output: process.stdout });

let run = AgentExecutor.stream({
  agent,
  provider,
  toolRegistry,
  approvalStore,
  input: process.argv[2] ?? 'Run the tests and fix what fails.',
  maxSteps: 30,
});
for await (const event of run) {
  if (event.type === 'text.delta') process.stdout.write(event.text);
  if (event.type === 'tool.start') console.log(`\n> ${event.toolName} ${JSON.stringify(event.args)}`);
}
let result: ExecutionResult = await run.result;

// resumeAfterApproval() returns a result, not a stream, so later steps print at the end.
while (result.finishReason === 'awaiting-approval' && result.approvalId) {
  const answer = await rl.question('\nApprove this call? [y/N] ');
  result = await resumeAfterApproval(
    { id: result.approvalId, approved: answer.trim().toLowerCase() === 'y' },
    approvalStore,
    toolRegistry,
    provider,
    { maxSteps: 30 }
  );
  process.stdout.write(result.text);
}
process.stdout.write('\n');
rl.close();
