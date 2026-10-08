/**
 * Repro: in a durable session (store with checkpoints), a turn that fails with a
 * deterministic provider error stays pending ('in-progress'), and every later
 * send() first re-runs that turn - so the customer's new messages never reach the
 * model and the session is stuck until someone calls discardPending() in code
 * (there is no HTTP route for it in createRouteHandler).
 *
 *   npx tsx support-desk/repro/poisoned-durable-turn.ts
 */
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { z } from 'zod';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bad = () => ({ error: Object.assign(new Error('Jinja Exception: System message must be at the beginning.'), { statusCode: 400 }) });
// Step 1 succeeds (a tool call, like the handoff in the live run) and is checkpointed; step 2 fails deterministically.
const model = mockModel([{ toolCalls: [{ name: 'lookup', args: {} }] }, bad(), bad(), bad(), 'finally answered']);
const lookup = defineTool({ name: 'lookup', description: 'lookup', input: z.object({}), execute: async () => 'ok' });
const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'sd-poison-')), 'agent.db'));
const agent = createAgent({ name: 'support', store, provider: model, retry: false, tools: [lookup] });

for (const text of ['first message', 'Hello?', 'Anyone there?']) {
  const session = agent.session({ id: 'cust-1' }); // a new object per HTTP request, like the route handler
  const r = await session.send(text).then((x) => `ok: ${x.text}`, (e: Error) => `threw ${e.name}: ${e.message.slice(0, 50)}`);
  console.log(`send(${JSON.stringify(text)}) -> ${r} | pending:`, JSON.stringify(await session.pending()));
}
console.log('user texts the model actually received per call:',
  JSON.stringify(model.calls.map((c) => c.messages.filter((m) => m.role === 'user').map((m) => m.content))));
store.close();
