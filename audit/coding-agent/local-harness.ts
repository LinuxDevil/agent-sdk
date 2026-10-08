/**
 * Coding agent harness against the LOCAL LM Studio model: copies fixture-repo/
 * to a fresh temp dir, lets a workspace-tools agent fix the failing
 * `node --test` suite, approves shell commands programmatically with an
 * allowlist, logs every decision, then verifies the result by running the
 * tests itself.
 *
 *   npx tsx coding-agent/local-harness.ts [--max-steps 30] [--keep]
 *
 * (Lives next to index.ts because another audit harness owns that file.)
 */
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  allow,
  ask,
  createAgent,
  createFsTools,
  createShellTool,
  NodeWorkspace,
  WorkspaceCheckpoints,
  type AgentEvent,
  type AgentHook,
  type PermissionRule,
} from '@lousho/build-ai-agent';
import { localProvider } from '../_shared/local.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixture-repo');
const argv = process.argv.slice(2);
const maxSteps = Number(argv[argv.indexOf('--max-steps') + 1]) || 30;
const keep = argv.includes('--keep');
const CTX = Number(process.env.LOCAL_CTX ?? 4096); // effective per-request window LM Studio gave us (see FINDINGS F12)

// ---------------------------------------------------------------- workspace
const root = mkdtempSync(path.join(tmpdir(), 'lousho-coding-'));
cpSync(fixture, root, { recursive: true });
const runDir = path.join(here, '.runs');
mkdirSync(runDir, { recursive: true });
const auditLog = path.join(runDir, `audit-${path.basename(root)}.jsonl`);
const log = (entry: Record<string, unknown>) => appendFileSync(auditLog, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);
const TEST_FILES = ['test/slugify.test.js', 'test/parseDuration.test.js'];
const testHashesBefore = TEST_FILES.map((f) => sha(path.join(root, f)));

const workspace = new NodeWorkspace({ root });
const checkpoints = new WorkspaceCheckpoints(workspace);

// ------------------------------------------------------------ shell policy
/** Commands the harness approves without a human. Everything else is denied. */
const SHELL_ALLOW: RegExp[] = [/^node --test(\s+[\w./-]+)*$/, /^npm test$/, /^(ls|dir)(\s+[\w./\\-]+)?$/];
function shellPolicy(command: string): { approved: boolean; why: string } {
  const hit = SHELL_ALLOW.find((re) => re.test(command.trim()));
  return hit ? { approved: true, why: `matches ${hit}` } : { approved: false, why: 'not on the harness allowlist (only node --test, npm test, ls/dir)' };
}

// ------------------------------------------------------------------ hooks
/** Guardrail hook: the agent may never touch the tests that judge it. */
const protectTests: AgentHook = {
  name: 'protect-tests',
  preToolCall(ctx) {
    if (!['write_file', 'edit_file'].includes(ctx.toolName)) return;
    const p = String(ctx.args.path ?? '').replace(/\\/g, '/');
    if (/(^|\/)test\//.test(p) || p.endsWith('.test.js')) {
      log({ kind: 'hook-veto', hook: 'protect-tests', tool: ctx.toolName, path: p });
      return { deny: 'Test files are read-only. Fix the code under src/ instead.' };
    }
  },
};

/** Loop guard that ignores the post-approval re-fire and never counts test runs (cf. FINDINGS F5). */
function loopGuard(maxRepeats = 3): AgentHook {
  const seen = new Map<string, number>();
  return {
    name: 'loop-guard',
    preToolCall(ctx) {
      if (ctx.resumedAfterApproval || ctx.toolName === 'shell') return;
      const key = `${ctx.toolName}:${JSON.stringify(ctx.args)}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > maxRepeats) {
        log({ kind: 'hook-veto', hook: 'loop-guard', tool: ctx.toolName, n });
        return { deny: `You already made this exact ${ctx.toolName} call ${maxRepeats} times. Do something different.` };
      }
    },
  };
}

/**
 * createAgent() has no per-call maxTokens option (FINDINGS F11), so cap each
 * model call's output here: a reasoning model on a small window otherwise thinks
 * past it and LM Studio fails the call with "Context size has been exceeded".
 */
const capOutput: AgentHook = {
  name: 'cap-output',
  preGenerate(ctx) {
    ctx.request.maxTokens = Number(process.env.MAX_OUT ?? 1024);
  },
};

// ------------------------------------------------------------ permissions
const permissions: PermissionRule[] = [
  { tool: ['write_file', 'edit_file'], when: (args) => /package\.json$/.test(String(args.path)), action: 'deny', reason: 'package.json is managed by the harness' },
  allow(['read_file', 'list_dir', 'glob', 'grep', 'edit_file', 'write_file']),
  ask('shell'),
];

// ------------------------------------------------------------------ agent
const provider = localProvider();
// A model call that fails after its first streamed chunk is never retried (FINDINGS F9), and a reasoning
// model streams reasoning first. Non-streaming calls move the failure to the whole call, where `retry` applies.
if (process.env.STREAM_CALLS !== '1') provider.supportsStreaming = () => false;

const agent = createAgent({
  name: 'coding-agent',
  provider,
  instructions: [
    'You are a careful coding agent fixing a small JavaScript (ESM) library.',
    'Tools: list_dir, read_file (numbered lines), edit_file (exact old_string -> new_string), write_file, grep, glob, shell.',
    `The shell is ${process.platform === 'win32' ? 'cmd.exe on Windows' : '/bin/sh'}. Allowed commands: "node --test" and "npm test".`,
    'Workflow: run `node --test`, read the failing file under src/, fix it with edit_file, run `node --test` again.',
    'Never edit files under test/. When every test passes, reply with a one-sentence summary of the fixes.',
  ].join('\n'),
  tools: [
    ...createFsTools(workspace, { checkpoints }),
    createShellTool(workspace, { needsApproval: true, defaultTimeoutMs: 60_000, maxOutputChars: Number(process.env.SHELL_MAX_CHARS ?? 1500) }),
  ],
  hooks: [capOutput, protectTests, loopGuard()],
  permissions,
  onPermissionDecision: (e) => log({ kind: 'permission', tool: e.toolName, decision: e.decision, rule: e.rule, args: e.args }),
  maxSteps,
  // LM Studio is shared with other agents; its "Context size has been exceeded" 500 is classified
  // 'unknown' / not retryable by the default rule (FINDINGS F8), so say so explicitly.
  retry: {
    maxRetries: 5,
    backoff: { initialMs: 5000 },
    retryOn: (error) => /Context size has been exceeded|server_error|ECONNRESET|fetch failed/i.test(String((error as Error)?.message ?? error)),
  },
  // The SDK cannot know LM Studio's loaded context (FINDINGS F12).
  compaction: { contextWindow: CTX, thresholdPercent: 0.6, protectedTokens: Math.round(CTX * 0.3) },
});

// -------------------------------------------------------------- run loop
const counts: Record<string, number> = {};
const short = (v: unknown, n = 140) => {
  const s = typeof v === 'string' ? v : String(JSON.stringify(v));
  return s.length > n ? s.slice(0, n) + '…' : s;
};
function show(e: AgentEvent): void {
  counts[e.type] = (counts[e.type] ?? 0) + 1;
  switch (e.type) {
    case 'step.start': console.log(`\n-- step ${e.step}`); break;
    case 'reasoning.done': console.log(`   [reasoning ${e.text.length} chars${e.tokens ? `, ${e.tokens} tok` : ''}]`); break;
    case 'text.done': console.log(`   text: ${short(e.text, 300)}`); break;
    case 'tool.start': console.log(`   tool.start ${e.toolName} ${short(e.args)}`); break;
    case 'tool.resume': console.log(`   tool.resume ${e.toolName} ${short(e.args)}`); break;
    case 'tool.done': console.log(`   tool.done ${e.toolName} (${e.durationMs}ms) ${short(e.result, 200)}`); break;
    case 'tool.error': console.log(`   tool.error ${e.toolName}: ${e.error.name}: ${short(e.error.message, 200)}`); break;
    case 'permission.decision': console.log(`   permission ${e.toolName} -> ${e.decision}${e.rule ? ` (rule ${e.rule.index})` : ''}${e.hook ? ` hook=${e.hook}` : ''}${e.reason ? ` ${e.reason}` : ''}`); break;
    case 'approval.requested': console.log(`   approval.requested ${e.toolName} ${short(e.args)}`); break;
    case 'step.done': console.log(`   step.done ${e.finishReason} usage=${e.usage ? `${e.usage.inputTokens}/${e.usage.outputTokens}${e.usage.estimated ? ' (est)' : ''}` : 'none'}`); break;
    case 'error': console.log(`   ERROR ${e.error.name}: ${e.error.message}`); break;
    case 'budget.exceeded': console.log(`   budget.exceeded ${e.limit} ${e.value}/${e.max}`); break;
    case 'compaction.done': console.log(`   compaction ${e.tokensBefore} -> ${e.tokensAfter} (pruned ${e.prunedToolCallIds.length})${e.error ? ' error=' + e.error.message : ''}`); break;
    case 'provider.retry': console.log(`   provider.retry ${e.attempt}/${e.maxRetries} ${e.error.category ?? ''} ${e.error.message.slice(0, 80)}`); break;
    case 'run.done': console.log(`== run.done ${e.finishReason} usage=${short(e.usage)}`); break;
  }
}

console.log(`workspace: ${root}\naudit log: ${auditLog}\nmaxSteps: ${maxSteps} ctx: ${CTX}`);
const started = Date.now();
let run = agent.stream('The test suite (`node --test`) fails. Find and fix the bugs in src/ until all tests pass.');
let approvals = 0;
let result: Awaited<typeof run.result> | undefined;
for (;;) {
  for await (const e of run) show(e);
  try {
    result = await run.result;
  } catch (error) {
    const e = error as Error & { category?: string; retryable?: boolean; code?: string };
    console.log(`run.result REJECTED: ${e.name} code=${e.code} category=${e.category} retryable=${e.retryable}: ${e.message.slice(0, 200)}`);
    break;
  }
  if (result.finishReason !== 'awaiting-approval' || !result.approvalId) break;
  const pending = await agent.approvals.get(result.approvalId);
  const command = String(pending?.args.command ?? '');
  const { approved, why } = pending?.toolName === 'shell' ? shellPolicy(command) : { approved: false, why: `unexpected tool ${pending?.toolName}` };
  approvals++;
  log({ kind: 'approval', id: result.approvalId, tool: pending?.toolName, command, approved, why });
  console.log(`   >> policy ${approved ? 'APPROVED' : 'DENIED'} ${JSON.stringify(command)} (${why})`);
  run = agent.approvals.streamResolve({ id: result.approvalId, approved, note: approved ? undefined : `Denied by policy: ${why}` });
}

// ------------------------------------------------------------- verdict
const secs = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\nlast finishReason=${result?.finishReason} steps=${result?.steps} approvalsDecided=${approvals} wall=${secs}s`);
console.log('usage (last segment):', JSON.stringify(result?.usage));
console.log('event counts:', JSON.stringify(counts));
console.log('final text:', short(result?.text ?? '', 600));
const testHashesAfter = TEST_FILES.map((f) => sha(path.join(root, f)));
console.log('tests untouched:', JSON.stringify(testHashesBefore) === JSON.stringify(testHashesAfter));
console.log('checkpoints:', JSON.stringify(await checkpoints.list({ sessionId: 'default' })));
const verify = spawnSync(process.execPath, ['--test'], { cwd: root, encoding: 'utf8' });
const summary = (verify.stdout.match(/^ℹ (tests|pass|fail) \d+$/gm) ?? []).join(', ');
console.log(`independent verification: node --test exit=${verify.status} ${summary}`);
for (const f of ['src/slugify.js', 'src/parseDuration.js']) {
  const before = readFileSync(path.join(fixture, f), 'utf8');
  const after = readFileSync(path.join(root, f), 'utf8');
  if (before !== after) console.log(`--- ${f} (changed)\n${after}`);
}
writeFileSync(path.join(runDir, `result-${path.basename(root)}.json`), JSON.stringify({ finishReason: result?.finishReason, usage: result?.usage, verifyExit: verify.status, summary, counts }, null, 2));
if (!keep && verify.status === 0) rmSync(root, { recursive: true, force: true });
process.exitCode = verify.status === 0 ? 0 : 1;
