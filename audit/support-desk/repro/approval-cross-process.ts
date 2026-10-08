/**
 * Repro: a durable session pauses on an approval in process 1; process 2 (same
 * SqliteStore file) decides it. Deterministic (mockModel), no LLM needed.
 *
 *   npx tsx support-desk/repro/approval-cross-process.ts           # runs all modes, each in fresh child processes
 *
 * Modes (process 2):
 *   direct      agent.approvals.resolve() without opening the session first
 *               (what approvals.md's "Keep the approvalId ... resolve a pause from somewhere else" suggests)
 *   concurrent  two session objects each resume() and resolve() concurrently (two HTTP requests / two clicks)
 */
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const [, , role, dbFile, mode, approvalId] = process.argv;
let executions = 0;

function build(file: string, script: Parameters<typeof mockModel>[0]) {
  const refund = defineTool({
    name: 'issue_refund',
    description: 'refund',
    input: z.object({ amountUsd: z.number() }),
    needsApproval: ({ amountUsd }) => amountUsd > 50,
    execute: async ({ amountUsd }) => { executions++; return { refunded: amountUsd }; },
  });
  const store = new SqliteStore(file);
  const agent = createAgent({
    name: 'billing',
    store,
    tools: [refund],
    provider: mockModel(script),
  });
  return { agent, store };
}

if (role === 'p1') {
  const { agent, store } = build(dbFile, [{ toolCalls: [{ name: 'issue_refund', args: { amountUsd: 129 } }] }]);
  const r = await agent.session({ id: 'cust-1' }).send('refund $129 please');
  console.log(JSON.stringify({ finishReason: r.finishReason, approvalId: r.approvalId }));
  store.close();
} else if (role === 'p2') {
  // Process 2's model only ever answers with text, so any second pause is the SDK's doing.
  const { agent, store } = build(dbFile, ['Refunded.', 'Refunded.', 'Anything else?', 'Anything else?', 'Anything else?']);
  const out: Record<string, unknown> = { mode };
  if (mode === 'proper') {
    // docs/sessions.md: "open the session and call resume() (or send()) once before resolving"
    await agent.session({ id: 'cust-1' }).resume().catch(() => {});
    const r = await agent.approvals.resolve({ id: approvalId, approved: true });
    out.resolve = { finishReason: r.finishReason, text: r.text };
  } else if (mode === 'direct') {
    const r = await agent.approvals.resolve({ id: approvalId, approved: true }).catch((e) => e);
    out.resolve = r instanceof Error ? `${r.name}: ${r.message}` : { finishReason: r.finishReason, text: r.text };
  } else {
    const s1 = agent.session({ id: 'cust-1' });
    const s2 = agent.session({ id: 'cust-1' });
    await Promise.all([s1.resume().catch(() => {}), s2.resume().catch(() => {})]);
    const results = await Promise.allSettled([
      agent.approvals.resolve({ id: approvalId, approved: true }),
      agent.approvals.resolve({ id: approvalId, approved: true }),
    ]);
    out.resolves = results.map((r) => (r.status === 'fulfilled' ? `ok:${r.value.finishReason}` : `rejected:${(r.reason as Error).message.slice(0, 80)}`));
  }
  out.toolExecutions = executions;
  const fresh = agent.session({ id: 'cust-1' });
  out.pendingAfter = await fresh.pending();
  out.transcriptAfter = ((await fresh.load()) ?? []).map((m) => `${m.role}:${typeof m.content === 'string' ? m.content.slice(0, 30) : ''}`);
  const next = await fresh.send('thanks, anything else?').catch((e: Error) => e);
  out.nextTurn = next instanceof Error ? `${next.name}: ${next.message.slice(0, 120)}` : `${next.finishReason}: ${next.text}`;
  // A supervisor sees a pending refund approval in the queue and approves it, as they would.
  const again = (await fresh.pending())?.approvalId;
  if (again) {
    const r2 = await agent.approvals.resolve({ id: again, approved: true }).catch((e: Error) => e);
    out.secondApproval = r2 instanceof Error ? r2.message.slice(0, 80) : r2.finishReason;
  }
  out.toolExecutionsTotal = executions;
  console.log(JSON.stringify(out, null, 1));
  store.close();
} else {
  const self = fileURLToPath(import.meta.url);
  for (const m of ['proper', 'direct', 'concurrent']) {
    const file = join(mkdtempSync(join(tmpdir(), 'sd-approval-')), 'agent.db');
    const run = (...a: string[]) => execFileSync(process.execPath, ['--import', 'tsx', self, ...a], { encoding: 'utf8' }).trim();
    const p1 = JSON.parse(run('p1', file).split('\n').at(-1)!);
    console.log(`--- mode=${m} p1:`, JSON.stringify(p1));
    console.log(run('p2', file, m, p1.approvalId));
  }
}
