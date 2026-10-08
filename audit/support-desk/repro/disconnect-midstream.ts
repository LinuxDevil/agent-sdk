/**
 * Repro: the client disconnects from the SSE stream while a side-effecting
 * (not approval-gated) tool is running. In-process createRouteHandler, mockModel.
 *
 *   npx tsx support-desk/repro/disconnect-midstream.ts
 */
import { createAgent, createRouteHandler, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const ledger: string[] = [];
const refund = defineTool({
  name: 'issue_refund',
  description: 'refund up to $50 without approval',
  input: z.object({ amountUsd: z.number() }),
  execute: async ({ amountUsd }, ctx) => {
    await new Promise((r) => setTimeout(r, 400)); // payment API latency
    ledger.push(`$${amountUsd} call=${ctx.toolCallId} aborted=${ctx.abortSignal?.aborted}`);
    return { refunded: amountUsd };
  },
});
const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'sd-disc-')), 'agent.db'));
const agent = createAgent({
  name: 'billing', store, tools: [refund],
  provider: mockModel([
    { toolCalls: [{ name: 'issue_refund', args: { amountUsd: 20 } }] }, 'Refunded $20.',
    // the retry turn: the model has no record of the first refund, so it refunds again
    { toolCalls: [{ name: 'issue_refund', args: { amountUsd: 20 } }] }, 'Refunded $20.',
  ]),
});
const { handler } = createRouteHandler(agent, { basePath: '/api' });

const controller = new AbortController();
const res = await handler(new Request('http://x/api/chat', {
  method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'cust-1', input: 'refund $20 please' }),
}));
const reader = res.body!.getReader();
const seen: string[] = [];
for (let c = await reader.read(); !c.done; c = await reader.read()) {
  const type = /"type":"([^"]+)"/.exec(new TextDecoder().decode(c.value))?.[1] ?? '?';
  seen.push(type);
  if (type === 'tool.start') { controller.abort(); await reader.cancel(); break; } // browser tab closed
}
await new Promise((r) => setTimeout(r, 800));
const session = agent.session({ id: 'cust-1' });
console.log('events before disconnect:', seen.join(','));
console.log('ledger after disconnect:', JSON.stringify(ledger));
console.log('stored transcript:', JSON.stringify((await session.load()) ?? []), '| pending:', JSON.stringify(await session.pending()));
const retry = await session.send('my connection dropped - did the $20 refund go through?');
console.log('retry turn:', JSON.stringify(retry.text), '| ledger now:', JSON.stringify(ledger));
store.close();
