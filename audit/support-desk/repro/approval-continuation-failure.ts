/**
 * Repro: an approved side-effecting tool runs, then the continuation's next
 * model call fails (LM Studio answered "Context size has been exceeded" in the
 * live run). What is left in the durable session?
 *
 *   npx tsx support-desk/repro/approval-continuation-failure.ts
 */
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

for (const how of ['resolve', 'streamResolve'] as const) {
  let executions = 0;
  const refund = defineTool({
    name: 'issue_refund',
    description: 'refund',
    input: z.object({ amountUsd: z.number() }),
    needsApproval: true,
    execute: async ({ amountUsd }) => { executions++; return { refunded: amountUsd }; },
  });
  const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'sd-cont-')), 'agent.db'));
  const agent = createAgent({
    name: 'billing',
    store,
    tools: [refund],
    provider: mockModel([
      { toolCalls: [{ name: 'issue_refund', args: { amountUsd: 129 } }] },
      { error: Object.assign(new Error('Engine protocol predict stream returned an error: Context size has been exceeded.'), { statusCode: 500 }) },
      'You have not been refunded yet - shall I refund $129?',
    ]),
    retry: false,
  });
  const session = agent.session({ id: 'cust-1' });
  const paused = await session.send('refund my $129 order');
  let outcome: string;
  if (how === 'resolve') {
    outcome = await agent.approvals.resolve({ id: paused.approvalId!, approved: true }).then((r) => r.finishReason, (e: Error) => `threw ${e.name}: ${e.message.slice(0, 60)}`);
  } else {
    const run = agent.approvals.streamResolve({ id: paused.approvalId!, approved: true });
    const types: string[] = [];
    for await (const e of run) types.push(e.type);
    outcome = `events=${types.join(',')}`;
  }
  const fresh = agent.session({ id: 'cust-1' });
  console.log(`--- ${how}:`, outcome);
  console.log('  refund tool executions:', executions);
  console.log('  stored transcript:', JSON.stringify(((await fresh.load()) ?? []).map((m) => m.role)));
  console.log('  pending():', JSON.stringify(await fresh.pending()));
  const next = await fresh.send('Did my refund go through?');
  console.log('  next turn sees:', JSON.stringify(next.text), '| transcript roles now:', JSON.stringify(fresh.messages.map((m) => m.role)));
  store.close();
}
