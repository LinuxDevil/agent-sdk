// D7: KVStore (Workers) - sessions use encodeBytes, but KVCheckpointStore and
// KVApprovalStore use plain JSON.stringify/parse. Image/file bytes in a
// checkpoint or approval snapshot come back as {"0":..,"1":..} objects.
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { KVStore } from '@lousho/build-ai-agent/kv';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const memKV = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) }; };
const png = new Uint8Array([137, 80, 78, 71]);
const input = [{ type: 'text', text: 'file a claim for this dent' }, { type: 'image', image: png, mediaType: 'image/png' }];
const imageIn = (req) => req.messages.find((m) => m.role === 'user').content.find((p) => p.type === 'image').image;
const show = (v) => (v instanceof Uint8Array ? `Uint8Array(${v.length})` : JSON.stringify(v));

// (a) approval pause -> resolve in a later request (new store object over the same KV)
{
  const kv = memKV();
  let seen;
  const tools = [defineTool({ name: 'file_claim', description: 'file a claim', input: z.object({}), needsApproval: true, execute: async () => 'ok' })];
  const model = mockModel([{ toolCalls: [{ name: 'file_claim', args: {} }] }, (r) => { seen = imageIn(r); return 'done'; }]);
  const paused = await createAgent({ provider: model, tools, store: new KVStore(kv) }).send(input, { sessionId: 'c1' });
  await createAgent({ provider: model, tools, store: new KVStore(kv) }).approvals.resolve({ id: paused.approvalId, approved: true });
  console.log('[KV approval] image after approval:', show(seen), seen instanceof Uint8Array ? 'PASS' : 'FAIL');
}
// (b) crash mid-turn -> agent.resume() from the KV checkpoint
{
  const kv = memKV();
  let seen;
  const tools = [defineTool({ name: 'measure', description: 'measure dent', input: z.object({}), execute: async () => '3cm' })];
  const crash = mockModel([{ toolCalls: [{ name: 'measure', args: {} }] }, { error: Object.assign(new Error('worker evicted'), { status: 503 }) }]);
  try { await createAgent({ provider: crash, tools, store: new KVStore(kv), retry: { maxRetries: 0 } }).send(input, { sessionId: 'c2' }); } catch {}
  const model = mockModel([(r) => { seen = imageIn(r); return 'done'; }]);
  await createAgent({ provider: model, tools, store: new KVStore(kv) }).resume('c2');
  console.log('[KV checkpoint resume] image after resume:', show(seen), seen instanceof Uint8Array ? 'PASS' : 'FAIL');
}
