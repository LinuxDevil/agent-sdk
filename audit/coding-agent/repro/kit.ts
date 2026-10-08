/**
 * The path a real user takes: `lousho add coding-kit` into a project, then
 * `loadAgentDir()` on it. Run via repro/kit.sh, which installs the kit into a
 * copy of fixture-repo/ and passes the directory here.
 *   npx tsx coding-agent/repro/kit.ts <agent-dir> [--model]   (--model: also run against LM Studio)
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import nodePath from 'node:path';
import { loadAgentDir, resolveAgentDir, type AgentEvent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { localProvider } from '../../_shared/local.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: kit.ts <agent-dir>');

// 1. What the directory resolves to.
const { config, manifest } = await resolveAgentDir(dir, { provider: mockModel(['x']) });
console.log('manifest.tools:', JSON.stringify(manifest.tools));
console.log('manifest.subagents:', JSON.stringify(manifest.subagents), 'skills:', JSON.stringify(manifest.skills));
console.log('manifest.registry:', JSON.stringify(manifest.registry));
console.log('config.maxSteps:', config.maxSteps, 'limits:', JSON.stringify(config.limits), 'compaction:', JSON.stringify(config.compaction));
console.log('tool names in config:', (Array.isArray(config.tools) ? (config.tools as Array<{ name: string }>) : []).map((t) => t.name).join(', '));

rmSync(nodePath.join(dir, '..', 'escaped.txt'), { force: true });
// 2. Deterministic probe of the kit's wiring: shell x3 (loop guard), an edit of a test file (approve.ts), an `rm` (permission deny).
const script = [
  { toolCalls: [{ name: 'shell', args: { command: 'node --test' } }] },
  { toolCalls: [{ name: 'shell', args: { command: 'node --test' } }] },
  { toolCalls: [{ name: 'shell', args: { command: 'node --test' } }] },
  { toolCalls: [{ name: 'edit_file', args: { path: 'test/slugify.test.js', old_string: "'hello-world'", new_string: "'Hello-World'" } }] },
  { toolCalls: [{ name: 'shell', args: { command: 'rm -rf src' } }] },
  { toolCalls: [{ name: 'shell', args: { command: 'git diff --no-index --output=../escaped.txt package.json instructions.md' } }] },
  { toolCalls: [{ name: 'edit_file', args: { path: 'approve.ts', old_string: "!String(args.path ?? '').endsWith('.test.js')", new_string: 'true' } }] },
  'done',
];
const probeEvents: AgentEvent[] = [];
// NB: an `onEvent` override is silently dropped by loadAgentDir, and stream() never consults the kit's
// approve.ts (docs/approvals.md), so build the same agent from resolveAgentDir() and use send() + onEvent.
const { config: probeConfig } = await resolveAgentDir(dir, { provider: mockModel(script) });
const { createAgent } = await import('@lousho/build-ai-agent');
const probe = createAgent({ ...probeConfig, onEvent: (e) => probeEvents.push(e) });
const probeRun = await probe.send('Fix the failing tests.');
console.log('\nprobe finishReason:', probeRun.finishReason, 'approvalId:', probeRun.approvalId ?? '-');
for (const e of probeEvents) {
  if (e.type === 'tool.start') console.log(`  tool.start ${e.toolName} ${JSON.stringify(e.args).slice(0, 90)}`);
  if (e.type === 'tool.done') console.log(`  tool.done  ${e.toolName} ${JSON.stringify(e.result).slice(0, 110)}`);
  if (e.type === 'tool.error') console.log(`  tool.error ${e.toolName} ${e.error.message.slice(0, 140)}`);
  if (e.type === 'permission.decision') console.log(`  permission ${e.toolName} ${e.decision}${e.reason ? ` (${e.reason})` : ''}${e.hook ? ` hook=${e.hook}` : ''}`);
  if (e.type === 'approval.requested') console.log(`  approval.requested ${e.toolName}`);
  if (e.type === 'budget.exceeded') console.log(`  budget.exceeded ${e.limit} ${e.value}/${e.max}`);
}
const { existsSync } = await import('node:fs');
const pathMod = await import('node:path');
console.log('  file written outside the agent dir by allow-listed `git diff`:', existsSync(pathMod.join(dir, '..', 'escaped.txt')));

// 3. Optionally run the real local model through the kit.
if (process.argv.includes('--model')) {
  const before = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8' });
  console.log('\nbefore: node --test exit', before.status);
  const agent = await loadAgentDir(dir, {
    provider: localProvider(),
    // The kit's compaction uses the model registry's window (128k default) - LM Studio loads 8k.
    compaction: { contextWindow: 8192, thresholdPercent: 0.6, protectedTokens: 1500 },
  });
  const counts: Record<string, number> = {};
  const run = agent.stream('The test suite (`node --test`) fails. Fix the bugs in src/ until it passes.');
  for await (const e of run) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'tool.start') console.log(`  tool.start ${e.toolName} ${JSON.stringify(e.args).slice(0, 100)}`);
    if (e.type === 'tool.error') console.log(`  tool.error ${e.toolName} ${e.error.message.slice(0, 140)}`);
    if (e.type === 'permission.decision' && e.decision === 'deny') console.log(`  DENY ${e.toolName} ${e.reason ?? ''}${e.hook ? ` hook=${e.hook}` : ''}`);
    if (e.type === 'budget.exceeded') console.log(`  budget.exceeded ${e.limit} ${e.value}/${e.max}`);
    if (e.type === 'approval.requested') console.log(`  approval.requested ${e.toolName}`);
    if (e.type === 'error') console.log(`  ERROR ${e.error.message.slice(0, 200)}`);
    if (e.type === 'run.done') console.log(`  run.done ${e.finishReason} usage=${JSON.stringify(e.usage)}`);
  }
  const res = await run.result.catch((err: Error) => ({ finishReason: `rejected: ${err.message.slice(0, 120)}`, text: '' }));
  console.log('result:', res.finishReason, (res.text ?? '').slice(0, 300));
  console.log('event counts:', JSON.stringify(counts));
  const after = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8' });
  console.log('after: node --test exit', after.status, (after.stdout.match(/^ℹ (pass|fail) \d+$/gm) ?? []).join(', '));
}
