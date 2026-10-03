/**
 * plan-mode - plan first, then let the agent edit (N4).
 *
 * A coding agent works on an in-memory workspace. The first turn runs in
 * `plan` mode: the agent may read files but every write is refused, so it
 * proposes the change. Then `session.setPermissionMode('acceptEdits')`, and
 * the second turn applies the plan: file edits run without asking.
 *
 * Runs offline with a scripted mock model. Set OPENROUTER_API_KEY to run it
 * against openai/gpt-4o-mini through OpenRouter instead.
 *
 * Run with: npx tsx examples/plan-mode/index.ts
 */
import { createAgent } from '../../src';
import { createFsTools } from '../../src/tools/workspace/fsTools';
import { MemoryWorkspace } from '../../src/tools/workspace/MemoryWorkspace';
import { mockModel } from '../../src/testing';

const workspace = new MemoryWorkspace({
  files: { 'greet.ts': "export function greet(name: string) {\n  return 'Hello ' + name;\n}\n" },
});

/** What the mock model does: in plan mode it tries a write (refused), then proposes; after the switch it edits. */
const scripted = mockModel([
  { toolCalls: [{ name: 'read_file', args: { path: 'greet.ts' } }] },
  { toolCalls: [{ name: 'edit_file', args: { path: 'greet.ts', old_string: "'Hello ' + name", new_string: '`Hello, ${name}!`' } }] },
  'Plan: in greet.ts, replace the string concatenation with the template literal `Hello, ${name}!`.',
  { toolCalls: [{ name: 'edit_file', args: { path: 'greet.ts', old_string: "'Hello ' + name", new_string: '`Hello, ${name}!`' } }] },
  'Done: greet.ts now uses a template literal.',
]);

const live = Boolean(process.env.OPENROUTER_API_KEY);

const agent = createAgent({
  name: 'plan-mode',
  instructions: 'You are a careful coding agent. Work only on the files in the workspace. Keep answers short.',
  ...(live ? { model: 'openrouter/openai/gpt-4o-mini' } : { provider: scripted }),
  maxSteps: 6,
  // write_file and edit_file ask before they run; acceptEdits lets them through.
  tools: createFsTools(workspace, { needsApproval: { write_file: true, edit_file: true } }),
  onPermissionDecision: (entry) => {
    if (entry.mode) console.log(`  [${entry.mode}] ${entry.toolName}: ${entry.decision}`);
  },
  onPermissionModeChange: ({ from, to }) => console.log(`  mode: ${from} -> ${to}`),
});

async function main() {
  const before = workspace.snapshot();
  const session = agent.session({ permissionMode: 'plan' });

  console.log('Turn 1 (plan mode):');
  const plan = await session.send('Change greet.ts so it greets with "Hello, <name>!" using a template literal. Plan it first.');
  console.log(plan.text);
  console.log('Workspace unchanged:', JSON.stringify(workspace.snapshot()) === JSON.stringify(before));

  session.setPermissionMode('acceptEdits');

  console.log('\nTurn 2 (acceptEdits):');
  const applied = await session.send('Apply your plan now.');
  console.log(applied.text, `(finish reason: ${applied.finishReason})`);
  console.log('\ngreet.ts now:\n' + workspace.snapshot()['greet.ts']);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
