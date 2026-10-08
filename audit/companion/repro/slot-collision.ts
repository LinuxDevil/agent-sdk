/**
 * Offline repro for F1: two memory slots that resolve to the SAME scope key
 * silently share one item list — remember_<a> items show up under recall_<b>
 * and inside slot b's <memory> block, because the storage key is the scope
 * key only (the slot name is not part of it).
 *
 * Uses sqliteMemory(':memory:') exactly like the live harness (two handles on
 * one SqliteStore), driven by mockModel — no network.
 *
 *   npx tsx companion/repro/slot-collision.ts   (from audit/)
 */
import { createAgent, defineMemory, memoryKey } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { SqliteStore, sqliteMemory } from '@lousho/build-ai-agent/sqlite';

const store = new SqliteStore(':memory:');
// Two handles, one backend — what a real multi-slot agent does with sqliteMemory(store).
const factsProvider = sqliteMemory(store);
const stateProvider = sqliteMemory(store);

const facts = defineMemory({ name: 'facts', scope: 'global', provider: factsProvider });
const state = defineMemory({ name: 'state', scope: 'global', provider: stateProvider }); // same scope key

const model = mockModel([
  { toolCalls: [{ name: 'remember_facts', args: { text: 'fact: likes ramen' } }] },
  { toolCalls: [{ name: 'remember_state', args: { text: '{"trust":10}' } }] },
  'done.',
]);

await createAgent({ provider: model, memory: [facts, state] }).send('hi');

const a = (await factsProvider.list(memoryKey(facts)!)).map((i) => i.text);
const b = (await stateProvider.list(memoryKey(state)!)).map((i) => i.text);
const raw = await factsProvider.list('global');
console.log('"facts" slot items :', a);
console.log('"state" slot items :', b);
console.log('items under the bare scope key :', raw.length);
const collided = !(a.length === 1 && a[0] === 'fact: likes ramen' && b.length === 1 && b[0] === '{"trust":10}' && raw.length === 0);
console.log(collided ? '\nBUG REPRODUCED: slots still share a bucket.' : '\nFIXED: each slot reads back only its own items.');
store.close();
process.exitCode = collided ? 0 : 1;
