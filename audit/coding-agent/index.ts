/**
 * Coding-agent audit harness — a mini Claude-Code run LIVE against OpenRouter
 * (`openrouter/openai/gpt-4o-mini`, OPENROUTER_API_KEY from the root .env).
 *
 * Scenario: a scratch project (.runs/<ts>/project) ships a TS file with an
 * off-by-one bug and a failing `node --test` suite. The agent must inspect,
 * plan (plan mode blocks writes), get approval for the edit, apply it, run the
 * tests, then document the fix — the NOTES.md write pauses, and a SECOND
 * PROCESS (resume-worker.ts) resolves it and finishes the durable session turn.
 *
 *   npx tsx coding-agent/index.ts
 *
 * Surfaces verified live: NodeWorkspace + createFsTools/createShellTool,
 * permissionMode 'plan' (incl. "denies even an allow-matched call"),
 * approvals via fileStore (pause -> approvals.get -> resolve), durable
 * session turn resumed across processes, multi-turn transcript re-opened by a
 * new createAgent() on the same store, and compaction (natural + manual).
 */
import '../_shared/env.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  allow,
  createAgent,
  createFsTools,
  createShellTool,
  fileStore,
  NodeWorkspace,
  WorkspaceCheckpoints,
  type AgentEvent,
  type AgentHook,
  type ExecutionResult,
  type PendingApproval,
  type PermissionRule,
} from '@lousho/build-ai-agent';
import { LIVE_MODEL, hasLiveKey, report } from '../_shared/env.ts';

if (!hasLiveKey) {
  console.error('OPENROUTER_API_KEY not set (loadAuditEnv found nothing). Bailing.');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(here, '.runs', stamp);
const project = path.join(runDir, 'project');
const storeDir = path.join(runDir, 'store');
mkdirSync(path.join(project, 'src'), { recursive: true });
mkdirSync(path.join(project, 'test'), { recursive: true });
const auditLog = path.join(runDir, 'events.jsonl');
const log = (entry: Record<string, unknown>) => appendFileSync(auditLog, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');

// ------------------------------------------------------------- the project
writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'scratch', type: 'module', scripts: { test: 'node --test' } }, null, 2));
writeFileSync(
  path.join(project, 'src', 'sumRange.ts'),
  [
    '/** Sum of every integer from `from` to `to`, inclusive. */',
    'export function sumRange(from: number, to: number): number {',
    '  let total = 0;',
    '  for (let i = from; i < to; i++) total += i;',
    '  return total;',
    '}',
    '',
  ].join('\n')
);
writeFileSync(
  path.join(project, 'test', 'sumRange.test.ts'),
  [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { sumRange } from '../src/sumRange.ts';",
    '',
    "test('sums a range inclusively', () => {",
    '  assert.equal(sumRange(1, 4), 10);',
    '  assert.equal(sumRange(3, 3), 3);',
    '});',
    '',
    "test('handles a single number and zero crossings', () => {",
    '  assert.equal(sumRange(-2, 2), 0);',
    '  assert.equal(sumRange(0, 0), 0);',
    '});',
    '',
  ].join('\n')
);

// Harness-side baseline: the suite must fail before the agent touches it.
const baseline = spawnSync(process.execPath, ['--test'], { cwd: project, encoding: 'utf8' });
report('baseline: fixture test suite fails', baseline.status === 1, `node --test exit=${baseline.status}`);

// ------------------------------------------------------------------ agent
const SESSION_ID = 'coding-task-1';
const workspace = new NodeWorkspace({ root: project });
const checkpoints = new WorkspaceCheckpoints(workspace);

const permissions: PermissionRule[] = [
  {
    tool: ['write_file', 'edit_file'],
    when: (a) => /(^|\/)test\//.test(String(a.path).replace(/\\/g, '/')),
    action: 'deny',
    reason: 'Test files are read-only; fix the code under src/ instead.',
  },
  // An allow rule that plan mode must still override (docs/permission-modes.md:
  // "denied ... also when an `allow` rule matched it").
  { tool: 'write_file', when: (a) => /PLAN\.md$/i.test(String(a.path)), action: 'allow' },
  allow(['read_file', 'list_dir', 'glob', 'grep']),
];

/** Deny the same tool call issued verbatim more than 3 times (a real loop guardrail). */
const loopGuard: AgentHook = {
  name: 'loop-guard',
  preToolCall(ctx) {
    if (ctx.resumedAfterApproval) return; // an approved call re-running is not a new attempt
    const key = `${ctx.toolName}:${JSON.stringify(ctx.args)}`;
    const n = (seen.set(key, (seen.get(key) ?? 0) + 1), seen.get(key)!);
    if (n > 3) return { deny: `You already made this exact ${ctx.toolName} call ${n - 1} times. It keeps failing — do something different.` };
  },
};
const seen = new Map<string, number>();

const makeAgent = () =>
  createAgent({
    name: 'coding-agent',
    model: LIVE_MODEL,
    store: fileStore(storeDir),
    instructions: [
      'You are a careful coding agent working in a small TypeScript (ESM) project.',
      'Tools: list_dir, glob, grep, read_file (numbered lines), edit_file (exact old_string -> new_string), write_file, shell.',
      `The shell is ${process.platform === 'win32' ? 'cmd.exe on Windows' : '/bin/sh'}; commands run in the workspace root. Only "node --test" is pre-approved; anything else pauses for a human.`,
      'Never modify files under test/. When all tests pass, summarize what you fixed in one or two sentences.',
    ].join('\n'),
    tools: [
      ...createFsTools(workspace, { needsApproval: { write_file: true, edit_file: true }, checkpoints }),
      createShellTool(workspace, {
        needsApproval: (command) => !/^node --test/.test(command.trim()),
        defaultTimeoutMs: 60_000,
      }),
    ],
    permissions,
    hooks: [loopGuard],
    onPermissionDecision: (e) =>
      log({ kind: 'permission', tool: e.toolName, decision: e.decision, mode: e.mode, rule: e.rule?.index, reason: e.reason, args: e.args }),
    onPermissionModeChange: (c) => log({ kind: 'mode-change', ...c }),
    // Small window so context pressure is reachable inside this audit run.
    compaction: { contextWindow: 2_000, thresholdPercent: 0.6, protectedTokens: 800 },
    maxSteps: 14,
  });

const agent = makeAgent();
const session = agent.session({ id: SESSION_ID, permissionMode: 'plan' });

// -------------------------------------------------------------- event log
const counts: Record<string, number> = {};
const planModeDenials: string[] = [];
const short = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
};
function show(e: AgentEvent): void {
  counts[e.type] = (counts[e.type] ?? 0) + 1;
  switch (e.type) {
    case 'step.start': console.log(`  -- step ${e.step}`); break;
    case 'tool.start': console.log(`  tool.start ${e.toolName} ${short(e.args)}`); break;
    case 'tool.resume': console.log(`  tool.resume ${e.toolName} ${short(e.args)}`); break;
    case 'tool.done': console.log(`  tool.done ${e.toolName} (${e.durationMs}ms) ${short(e.result, 160)}`); break;
    case 'tool.error': console.log(`  tool.error ${e.toolName}: ${e.error.name}: ${short(e.error.message, 160)}`); break;
    case 'permission.decision':
      console.log(`  permission ${e.toolName} -> ${e.decision}${e.mode ? ` mode=${e.mode}` : ''}${e.rule ? ` rule=${e.rule.index}` : ''}${e.reason ? ` "${short(e.reason, 90)}"` : ''}`);
      if (e.mode === 'plan' && e.decision === 'deny') planModeDenials.push(e.toolName);
      break;
    case 'approval.requested': console.log(`  approval.requested ${e.toolName} ${short(e.args)}`); break;
    case 'text.done': console.log(`  text: ${short(e.text, 400)}`); break;
    case 'compaction.start': console.log(`  compaction.start strategy=${e.strategy} tokens=${e.tokensBefore}/${e.thresholdTokens}`); break;
    case 'compaction.done': console.log(`  compaction.done ${e.tokensBefore} -> ${e.tokensAfter} trigger=${e.trigger}${e.error ? ` error=${e.error.message}` : ''}`); break;
    case 'error': console.log(`  ERROR ${e.error.name}: ${short(e.error.message, 200)}`); break;
    case 'provider.retry': console.log(`  provider.retry ${e.attempt}/${e.maxRetries} ${short(e.error.message, 100)}`); break;
    case 'run.done': console.log(`  == run.done ${e.finishReason}`); break;
  }
}
session.on(show);

/** Approve edits/writes inside src/ or root docs; approve only `node --test` on the shell. */
function decide(pending: PendingApproval | undefined): { approved: boolean; note?: string } {
  if (!pending) return { approved: false, note: 'harness could not find the pending approval' };
  if (pending.toolName === 'shell') {
    const ok = /^node --test/.test(String(pending.args.command ?? '').trim());
    return ok ? { approved: true } : { approved: false, note: 'Harness policy: only `node --test` may run.' };
  }
  if (pending.toolName === 'write_file' || pending.toolName === 'edit_file') {
    const p = String(pending.args.path ?? '').replace(/\\/g, '/');
    const ok = /(^|\/)src\//.test(p) || /(^|\/)(NOTES|PLAN)\.md$/i.test(p);
    return ok ? { approved: true } : { approved: false, note: `Harness policy: no writes to ${p}.` };
  }
  return { approved: false, note: `Harness policy: unexpected tool ${pending.toolName}.` };
}

async function drive(input: string): Promise<ExecutionResult> {
  let result = await session.send(input);
  while (result.finishReason === 'awaiting-approval' && result.approvalId) {
    const pending = await agent.approvals.get(result.approvalId);
    const d = decide(pending);
    console.log(`  >> harness ${d.approved ? 'APPROVED' : 'DENIED'} ${pending?.toolName} ${short(pending?.args, 120)}${d.note ? ` (${d.note})` : ''}`);
    log({ kind: 'approval-decision', id: result.approvalId, tool: pending?.toolName, ...d });
    result = await agent.approvals.resolve({ id: result.approvalId, approved: d.approved, ...(d.note && { note: d.note }) });
  }
  return result;
}

console.log(`model: ${LIVE_MODEL}\nproject: ${project}\nstore: ${storeDir}\naudit log: ${auditLog}`);

// ============================ PHASE 1: plan mode ===========================
console.log('\n=== PHASE 1: plan mode (session starts in plan) ===');
const t1 = await drive(
  'The test suite in this workspace fails. Inspect the project with list_dir and read_file, diagnose the bug, then write your diagnosis and fix plan to PLAN.md using write_file. End with a one-paragraph plan in your reply.'
);
const planMdExists = existsSync(path.join(project, 'PLAN.md'));
report('plan mode: read tools ran', (counts['tool.done'] ?? 0) > 0, `${counts['tool.done'] ?? 0} tool.done events in turn 1`);

// Phase 1b: still in plan mode, order a mutation outright — the gate must deny
// it even though the model was told to and an `allow` rule matches PLAN.md.
console.log('\n=== PHASE 1b: ordered to mutate while still in plan mode ===');
const t1b = await drive('Do it now anyway: call write_file to create PLAN.md with your plan, then call edit_file on src/sumRange.ts to apply the fix.');
const planMdExistsAfter = existsSync(path.join(project, 'PLAN.md'));
const srcUnchanged = readFileSync(path.join(project, 'src', 'sumRange.ts'), 'utf8').includes('i < to');
report(
  'plan mode: mutating calls denied (even allow-matched)',
  planModeDenials.length > 0 && !planMdExistsAfter && srcUnchanged,
  `denied calls: ${JSON.stringify(planModeDenials)}; PLAN.md exists=${planMdExistsAfter}; src still buggy=${srcUnchanged}; turn1b finishReason=${t1b.finishReason}`
);

// ====================== PHASE 2: edit approval + fix =======================
console.log('\n=== PHASE 2: default mode — edit_file pauses for approval ===');
session.setPermissionMode('default');
const before = readFileSync(path.join(project, 'src', 'sumRange.ts'), 'utf8');
const t2 = await drive('Apply the plan: fix the bug in src/sumRange.ts using edit_file, then run `node --test` with the shell tool to confirm the suite passes.');
const srcChanged = readFileSync(path.join(project, 'src', 'sumRange.ts'), 'utf8') !== before;
report('approvals: edit paused and resumed in-process', srcChanged, `src/sumRange.ts changed=${srcChanged}, turn2 finishReason=${t2.finishReason}`);

// ============== PHASE 3: durable pause, resumed by a 2nd process ===========
console.log('\n=== PHASE 3: pause survives into a second process (fileStore) ===');
const t3 = await session.send('Create NOTES.md in the workspace root documenting the bug you fixed (one short paragraph). Do not change anything else.');
const pausedId = t3.approvalId;
const approvalFile = pausedId ? path.join(storeDir, 'approvals', `${pausedId}.json`) : '';
const durablePause = Boolean(pausedId && existsSync(approvalFile));
report('approvals: write paused durably', durablePause, `approvalId=${pausedId} on disk=${durablePause}`);
let childOk = false;
if (pausedId) {
  const child = spawnSync(
    process.execPath,
    [path.join(here, 'resume-worker.ts'), '--store', storeDir, '--session', SESSION_ID, '--approval', pausedId, '--root', project, '--decision', 'approve'],
    { encoding: 'utf8', timeout: 300_000, env: { ...process.env } }
  );
  console.log(child.stdout.split('\n').map((l) => `  | ${l}`).join('\n'));
  if (child.status !== 0) console.log(`  | worker stderr: ${short(child.stderr, 400)}`);
  childOk = child.status === 0 && existsSync(path.join(project, 'NOTES.md'));
  // What does the original (pre-pause) session object see after another
  // process finished its turn? pending() should be null now.
  console.log(`  parent session.pending() after child resolved: ${JSON.stringify(await session.pending())}`);
}
report('restart: second process resumed paused session turn', childOk, `WORKER_DONE + NOTES.md exists=${existsSync(path.join(project, 'NOTES.md'))}`);

// ============ PHASE 4: new agent + same store reopens the session ==========
console.log('\n=== PHASE 4: new createAgent() on the same fileStore reopens the session ===');
const agent2 = makeAgent();
const session2 = agent2.session({ id: SESSION_ID });
const reopened = await session2.load();
const t4 = await session2.send('In one sentence: what was the bug and how did you fix it?');
const mentionsBug = /upper (bound|limit|boundary)|off.by.one|inclusive|<=/.test(t4.text);
report('sessions: transcript survived "restart"', reopened.length > 0 && mentionsBug, `messages=${reopened.length}; turn4 says: ${short(t4.text, 200)}`);

// ============================ PHASE 5: compaction ==========================
console.log('\n=== PHASE 5: compaction ===');
const natural = counts['compaction.done'] ?? 0;
report('compaction: fired naturally during the run', natural > 0, `compaction.done count=${natural}`);
const compacted = await session2.compact();
console.log(`  manual session.compact(): ${JSON.stringify(compacted)}`);
report('compaction: manual session.compact() works', compacted.messagesAfter >= 0 && compacted.messagesAfter <= compacted.messagesBefore, JSON.stringify(compacted));

// ----------------------------------------------------------------- verdict
console.log('\n=== VERDICT ===');
const verify = spawnSync(process.execPath, ['--test'], { cwd: project, encoding: 'utf8' });
const summary = (verify.stdout.match(/(tests|pass|fail)\s+\d+/g) ?? []).join(', ');
report('end state: node --test passes', verify.status === 0, `exit=${verify.status} ${summary}`);
console.log('event counts:', JSON.stringify(counts));
console.log(`workspace checkpoints: ${JSON.stringify(await checkpoints.list({ sessionId: SESSION_ID }))}`);
console.log(`project files: ${['PLAN.md', 'NOTES.md', 'src/sumRange.ts'].map((f) => `${f}=${existsSync(path.join(project, f))}`).join(' ')}`);
console.log('\n--- fixed src/sumRange.ts ---\n' + readFileSync(path.join(project, 'src', 'sumRange.ts'), 'utf8'));
console.log(`run dir kept at ${runDir}`);
