/**
 * Repro: two concurrent turns on the same session id, each through its own
 * `agent.session({ id })` object - which is exactly what `createRouteHandler`
 * does for two overlapping `POST /chat` requests (fetchRoutes.ts openSession()).
 * Deterministic (mockModel with a delay), durable SqliteStore.
 *
 *   npx tsx support-desk/repro/concurrent-session-objects.ts
 */
import { createAgent } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const durable of [false, true]) {
  const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'sd-conc-')), 'agent.db'));
  const agent = createAgent({
    name: 'support',
    store: durable ? store : { sessions: store.sessions },
    provider: mockModel([{ text: 'Answer to the FIRST message', delayMs: 300 }, { text: 'Answer to the SECOND message', delayMs: 300 }, 'Answer three']),
  });
  const a = agent.session({ id: 'cust-1' });
  const b = agent.session({ id: 'cust-1' });
  const results = await Promise.allSettled([a.send('first: where is my order?'), b.send('second: my shoe size is 42')]);
  const saved = (await agent.session({ id: 'cust-1' }).load()) ?? [];
  console.log(`--- durable checkpoints=${durable}`);
  console.log('  results:', results.map((r) => (r.status === 'fulfilled' ? r.value.text : `rejected: ${(r.reason as Error).message.slice(0, 80)}`)));
  console.log('  stored transcript:', JSON.stringify(saved.map((m) => `${m.role}: ${String(m.content).slice(0, 40)}`)));
  console.log('  user messages kept:', saved.filter((m) => m.role === 'user').length, 'of 2');
  // Same session object, for comparison: queued in order.
  const c = agent.session({ id: 'cust-2' });
  await Promise.all([c.send('x'), c.send('y')]).catch(() => {});
  store.close();
}
