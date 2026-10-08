/**
 * Second-process resumer: rebuilds the coding agent against the same
 * fileStore + workspace, opens the session, observes the pending-turn state
 * exactly as a restarted CLI would, then decides the pending approval.
 *
 *   node resume-worker.ts --store <dir> --session <id> --approval <id>
 *                         [--decision approve|deny] [--note <text>] [--root <dir>]
 *
 * Run with plain `node` (>=22.18, type stripping) or `npx tsx`.
 */
import '../_shared/env.ts';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  allow,
  createAgent,
  createFsTools,
  createShellTool,
  NodeWorkspace,
  fileStore,
  type AgentEvent,
  type PermissionRule,
} from '@lousho/build-ai-agent';
import { LIVE_MODEL } from '../_shared/env.ts';

const argv = process.argv.slice(2);
const arg = (name: string) => argv[argv.indexOf(`--${name}`) + 1];
const storeDir = arg('store');
const sessionId = arg('session');
const approvalId = arg('approval');
const decision = arg('decision') === 'deny' ? 'deny' : 'approve';
const note = argv.includes('--note') ? arg('note') : undefined;
const root = arg('root');

if (!storeDir || !sessionId || !approvalId || !root) {
  console.error('usage: resume-worker --store <dir> --session <id> --approval <id> --root <dir> [--decision deny] [--note s]');
  process.exit(2);
}

console.log(`[worker pid=${process.pid}] store=${storeDir} session=${sessionId} approval=${approvalId} decision=${decision}`);

// What a restarted process can see on disk BEFORE opening the session.
const approvalFile = path.join(storeDir, 'approvals', `${approvalId}.json`);
console.log(`[worker] durable approval record exists: ${existsSync(approvalFile)} (${approvalFile})`);
if (existsSync(approvalFile)) {
  const saved = JSON.parse(readFileSync(approvalFile, 'utf8'));
  console.log(`[worker] saved record: tool=${saved.pending?.toolName} args=${JSON.stringify(saved.pending?.args)?.slice(0, 160)}`);
}

const workspace = new NodeWorkspace({ root });
const permissions: PermissionRule[] = [
  { tool: ['write_file', 'edit_file'], when: (a) => /(^|\/)test\//.test(String(a.path).replace(/\\/g, '/')), action: 'deny', reason: 'Test files are read-only.' },
  { tool: 'write_file', when: (a) => /PLAN\.md$/i.test(String(a.path)), action: 'allow' },
  allow(['read_file', 'list_dir', 'glob', 'grep']),
];

const agent = createAgent({
  name: 'coding-agent',
  model: LIVE_MODEL,
  store: fileStore(storeDir),
  instructions: 'You are a careful coding agent.',
  tools: [
    ...createFsTools(workspace, { needsApproval: { write_file: true, edit_file: true } }),
    createShellTool(workspace, { needsApproval: (command) => !/^node --test/.test(command.trim()), defaultTimeoutMs: 60_000 }),
  ],
  permissions,
  onPermissionDecision: (e) => console.log(`[worker] permission ${e.toolName} -> ${e.decision}${e.mode ? ` mode=${e.mode}` : ''}`),
  maxSteps: 12,
});

// A restarted CLI lists what its process paused on: nothing (that list is in-memory).
console.log(`[worker] approvals.list() after restart: ${JSON.stringify((await agent.approvals.list()).map((a) => a.id))}`);
const found = await agent.approvals.get(approvalId);
console.log(`[worker] approvals.get(${approvalId.slice(0, 8)}...): ${found ? `${found.toolName} ${JSON.stringify(found.args).slice(0, 120)}` : 'NOT FOUND'}`);

const session = agent.session({ id: sessionId });
session.on((e: AgentEvent) => {
  if (e.type === 'tool.start' || e.type === 'tool.resume') console.log(`[worker] ${e.type} ${e.toolName}`);
  if (e.type === 'tool.done') console.log(`[worker] tool.done ${e.toolName} (${e.durationMs}ms)`);
  if (e.type === 'tool.error') console.log(`[worker] tool.error ${e.toolName}: ${e.error.message.slice(0, 140)}`);
  if (e.type === 'text.done') console.log(`[worker] text: ${e.text.slice(0, 300)}`);
});

// Per docs/sessions.md: open the session and resume() once so the agent knows
// which session the approval belongs to. Expected to throw awaiting-approval.
try {
  const pending = await session.pending();
  console.log(`[worker] session.pending(): ${JSON.stringify(pending)}`);
  const resumed = await session.resume();
  console.log(`[worker] session.resume() returned: ${JSON.stringify(resumed?.finishReason ?? null)}`);
} catch (error) {
  const e = error as Error & { approvalId?: string; code?: string };
  console.log(`[worker] session.resume() threw ${e.name} code=${e.code} approvalId=${e.approvalId}`);
}

const result = await agent.approvals.resolve({ id: approvalId, approved: decision === 'approve', ...(note !== undefined && { note }) });
console.log(`[worker] resolve -> finishReason=${result.finishReason} steps=${result.steps}`);
console.log(`[worker] final text: ${result.text.slice(0, 400)}`);
console.log(`[worker] transcript length now: ${session.messages.length}`);
console.log('WORKER_DONE');
