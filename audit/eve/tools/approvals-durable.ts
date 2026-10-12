/* TOOLS: durable pending approvals across a "restart" (two createAgent instances over one fileStore).
   Checks list() / get() / resolve() after restart, and concurrent resolve of the same id.
   Run: npx tsx eve/tools/approvals-durable.ts */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent, defineTool, fileStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const dir = mkdtempSync(join(tmpdir(), 'eve-appr-'));
let runs = 0;
const deploy = defineTool({
  name: 'deploy', description: 'Deploy', input: z.object({ env: z.string() }),
  needsApproval: true, execute: async ({ env }) => { runs++; return `deployed ${env}`; },
});
const mk = () => createAgent({
  provider: mockModel([{ toolCalls: [{ name: 'deploy', args: { env: 'prod' } }] }, 'done', 'done', 'done'], { onExhausted: 'repeat-last' }),
  instructions: 'i', tools: [deploy], store: fileStore(dir),
});

const a1 = mk();
const paused = await a1.session({ id: 's1' }).send('deploy prod');
console.log('process A: finishReason', paused.finishReason, 'approvalId', Boolean(paused.approvalId));
console.log('process A: list() ->', (await a1.approvals.list()).length);

const a2 = mk(); // "restart"
console.log('process B (after restart): list() ->', (await a2.approvals.list()).length, '  get(id) ->', Boolean(await a2.approvals.get(paused.approvalId!)));

// concurrent double resolve of the same pending approval in process B and process C
const a3 = mk();
const results = await Promise.allSettled([
  a2.approvals.resolve({ id: paused.approvalId!, approved: true }),
  a3.approvals.resolve({ id: paused.approvalId!, approved: true }),
]);
console.log('double resolve:', results.map((r) => r.status === 'fulfilled' ? `ok:${r.value.finishReason}` : `err:${String((r.reason as Error).message).slice(0, 60)}`).join(' | '), '| tool executions:', runs);
