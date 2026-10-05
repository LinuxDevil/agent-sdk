/**
 * coding-harness - a small coding harness assembled from Lousho's building blocks.
 *
 * `createCodingHarness()` stacks the layers most open-source harnesses share
 * (OpenCode, Codex, Pi, Crush) on top of one `createAgent()` call:
 *
 *   1. instructions per model family     5. a loop guard and an output cap (hooks)
 *   2. workspace tools with undo         6. context compaction
 *   3. a shell limited to an allow list  7. a playbook loaded on demand (skill)
 *   4. permission rules and an approver  8. a read-only explorer sub-agent
 *
 * Offline (the default) it fixes a bug in an in-memory project with scripted
 * mock models. With OPENROUTER_API_KEY set it runs the same task for real on
 * openrouter/openai/gpt-4o-mini, in a temporary copy of the project.
 *
 * Run with: npx tsx examples/coding-harness/index.ts
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allow,
  ask,
  createAgent,
  createFsTools,
  createShellTool,
  defineSkill,
  MemoryWorkspace,
  NodeWorkspace,
  WorkspaceCheckpoints,
  type AgentHook,
  type LLMProvider,
} from '../../src';
import { mockModel } from '../../src/testing';

/** The project the harness works on: `add()` subtracts, so its test fails. */
export const FIXTURE: Record<string, string> = {
  'math.js': 'exports.add = (a, b) => a - b;\n',
  'math.test.js':
    "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('./math');\n\ntest('add', () => assert.strictEqual(add(2, 3), 5));\n",
};

export const LIVE_MODEL = 'openrouter/openai/gpt-4o-mini';

// 1. Instructions per model family. Harnesses such as OpenCode keep one prompt per family;
//    here a shared core plus a short family-specific tail.
const CORE_INSTRUCTIONS = [
  'You are a careful coding agent working in a small JavaScript project.',
  'Read a file before you edit it. Make the smallest change that fixes the problem.',
  'Run `node --test` before and after every change, and stop once it passes.',
  'For a task you do not understand yet, delegate the reading to the explorer sub-agent.',
].join('\n');

const FAMILY_TAILS: Record<string, string> = {
  anthropic: 'Think briefly, then act. Prefer edit_file over write_file.',
  openai: 'Call one tool at a time and keep your final answer to one sentence.',
};

export function instructionsFor(model: string): string {
  const family = Object.keys(FAMILY_TAILS).find((name) => model.includes(name));
  return family ? `${CORE_INSTRUCTIONS}\n${FAMILY_TAILS[family]}` : CORE_INSTRUCTIONS;
}

// 5a. Loop guard: deny a tool call the model already made twice with the same arguments.
//     Crush, Cline and Gemini CLI all ship a version of this.
export function loopGuard(maxRepeats = 2): AgentHook {
  const seen = new Map<string, number>();
  return {
    name: 'loop-guard',
    preToolCall(ctx) {
      const key = `${ctx.sessionId ?? ''}:${ctx.toolName}:${JSON.stringify(ctx.args)}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > maxRepeats) {
        return { deny: `You already called ${ctx.toolName} with these arguments ${maxRepeats} times. Try something else.` };
      }
      return undefined;
    },
  };
}

// 5b. Output cap: keep long tool results from flooding the context.
export function outputCap(maxChars = 4_000): AgentHook {
  return {
    name: 'output-cap',
    postToolCall(_ctx, result) {
      const text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? '');
      if (text.length <= maxChars) return undefined;
      return { result: `${text.slice(0, maxChars)}\n[output cut at ${maxChars} of ${text.length} chars]` };
    },
  };
}

// 7. A playbook the model loads only when it needs it.
const fixFailingTest = defineSkill({
  name: 'fix-failing-test',
  description: 'Steps for fixing a failing unit test',
  content: [
    '# Fixing a failing test',
    '1. Run the tests and read the failure message.',
    '2. Read the code under test, not only the test.',
    '3. Change the code, not the test, unless the test is wrong.',
    '4. Run the tests again and report what changed in one sentence.',
  ].join('\n'),
});

export interface CodingHarnessOptions {
  workspace: MemoryWorkspace | NodeWorkspace;
  /** A provider/model string for live runs, e.g. `openrouter/openai/gpt-4o-mini`. */
  model?: string;
  /** Providers for offline runs and tests; used instead of `model`. */
  provider?: LLMProvider;
  /** The explorer's provider offline; defaults to `provider`. */
  explorerProvider?: LLMProvider;
  /** Called for every permission decision: the harness's audit log. */
  onAudit?: (line: string) => void;
}

export function createCodingHarness(options: CodingHarnessOptions) {
  const { workspace, model = LIVE_MODEL, onAudit = () => {} } = options;
  const modelOptions = (provider?: LLMProvider) => (provider ? { provider } : { model });

  // 2. Workspace tools; every write and edit is backed up so it can be rewound.
  const checkpoints = new WorkspaceCheckpoints(workspace);
  const fsTools = createFsTools(workspace, { checkpoints });
  const readOnlyTools = fsTools.filter((tool) => ['read_file', 'list_dir', 'glob', 'grep'].includes(tool.name));

  // 3. A shell that only runs the commands the harness needs.
  const shell = createShellTool(workspace, {
    needsApproval: false,
    allow: ['node --test', 'git status', 'git diff'],
  });

  // 8. A read-only explorer the lead can hand a question to, in a clean context.
  const explorer = createAgent({
    name: 'explorer',
    description: 'Reads the project and reports where a problem is. Cannot change files.',
    instructions: 'You read code and answer in two sentences: which file and line, and what is wrong.',
    ...modelOptions(options.explorerProvider ?? options.provider),
    tools: readOnlyTools,
    maxSteps: 6,
  });

  const agent = createAgent({
    name: 'coding-harness',
    instructions: instructionsFor(model),
    ...modelOptions(options.provider),
    tools: [...fsTools, shell],
    skills: [fixFailingTest],
    subagents: { explorer },

    // 4. Rules first, first match wins; then an approver decides what would pause.
    permissions: [
      { tool: 'shell', when: (args) => /\brm\b/.test(String(args.command)), action: 'deny', reason: 'Deleting files is not allowed' },
      allow(['read_file', 'list_dir', 'glob', 'grep', 'load_skill', 'task', 'shell']),
      ask(['write_file', 'edit_file']),
    ],
    approve: ({ args }) => !String(args.path ?? '').endsWith('.test.js'), // never let it edit the tests
    onPermissionDecision: (entry) => onAudit(`${entry.toolName}: ${entry.decision}${entry.rule?.reason ? ` (${entry.rule.reason})` : ''}`),

    // 5. Hooks run in order: the loop guard first, then the output cap.
    hooks: [loopGuard(), outputCap()],

    // 6. Prune old tool results above 80% of the context window.
    compaction: { thresholdPercent: 0.8 },

    maxSteps: 20,
    limits: { maxCostUsd: 0.05 },
  });

  return { agent, checkpoints };
}

/** The shell an offline run fakes: `node --test` passes once add() adds. */
export function fakeExec(workspace: () => MemoryWorkspace) {
  return (command: string) => {
    if (command !== 'node --test') return { exitCode: 127, stderr: `unknown command: ${command}\n` };
    const fixed = workspace().snapshot()['math.js']?.includes('a + b');
    return fixed
      ? { exitCode: 0, stdout: '# pass 1\n# fail 0\n' }
      : { exitCode: 1, stdout: '# pass 0\n# fail 1\n', stderr: 'AssertionError: -1 !== 5\n' };
  };
}

/** What the scripted lead does offline: skill, test, a refused command, delegate, fix, test, answer. */
export function scriptedLead() {
  return mockModel([
    { toolCalls: [{ name: 'load_skill', args: { name: 'fix-failing-test' } }] },
    { toolCalls: [{ name: 'shell', args: { command: 'node --test' } }] },
    { toolCalls: [{ name: 'shell', args: { command: 'rm -rf node_modules' } }] },
    { toolCalls: [{ name: 'task', args: { agent: 'explorer', prompt: 'Why does add(2, 3) not return 5?', description: 'Find the add bug' } }] },
    { toolCalls: [{ name: 'edit_file', args: { path: 'math.js', old_string: 'a - b', new_string: 'a + b' } }] },
    { toolCalls: [{ name: 'shell', args: { command: 'node --test' } }] },
    { text: 'Fixed add() in math.js (it subtracted); node --test now passes.' },
  ]);
}

export function scriptedExplorer() {
  return mockModel([
    { toolCalls: [{ name: 'read_file', args: { path: 'math.js' } }] },
    { text: 'math.js line 1: add() returns a - b. It should return a + b.' },
  ]);
}

function liveWorkspace(): NodeWorkspace {
  const root = mkdtempSync(path.join(tmpdir(), 'coding-harness-'));
  for (const [file, content] of Object.entries(FIXTURE)) writeFileSync(path.join(root, file), content);
  return new NodeWorkspace({ root });
}

async function main() {
  const live = Boolean(process.env.OPENROUTER_API_KEY);
  const onAudit = (line: string) => console.log(`  [audit] ${line}`);

  let memory: MemoryWorkspace | undefined;
  const workspace = live ? liveWorkspace() : (memory = new MemoryWorkspace({ files: FIXTURE, exec: fakeExec(() => memory!) }));
  const { agent, checkpoints } = createCodingHarness(
    live ? { workspace, onAudit } : { workspace, provider: scriptedLead(), explorerProvider: scriptedExplorer(), onAudit }
  );

  console.log(live ? `Live run on ${LIVE_MODEL} in ${(workspace as NodeWorkspace).root}` : 'Offline run with scripted models');
  const session = agent.session();
  const result = await session.send('The test in math.test.js fails. Fix it.');

  console.log(`\n${result.text}`);
  console.log(`finish reason: ${result.finishReason}, steps: ${result.steps ?? 'n/a'}, cost: ${result.usage?.costUsd ?? 'n/a'} USD`);
  console.log(`checkpointed turns: ${JSON.stringify(await checkpoints.list({ sessionId: session.id }))}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
