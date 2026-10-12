// D6: SqliteApprovalStore.save() serializes the approval snapshot with plain
// JSON.stringify (no encodeBytes replacer), while load/resolve parse with
// decodeBytes. A paused run whose transcript holds image/file bytes comes back
// from the approval with the Uint8Array turned into {"0":137,"1":80,...}.
// fileStore uses encodeBytes for the same record, so only SQLite corrupts.
import { createAgent, defineTool, fileStore } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const tools = [defineTool({ name: 'file_claim', description: 'file an insurance claim', input: z.object({}), needsApproval: true, execute: async () => 'filed' })];
const dir = mkdtempSync(join(tmpdir(), 'eve-d6-'));
for (const [name, makeStore] of [['fileStore', () => fileStore(dir)], ['SqliteStore', () => new SqliteStore(join(dir, 'a.db'))]]) {
  let seen;
  const model = mockModel([
    { toolCalls: [{ name: 'file_claim', args: {} }] },
    (req) => { seen = req.messages.find((m) => m.role === 'user').content.find((p) => p.type === 'image').image; return 'claim filed'; },
  ]);
  // process 1 pauses; process 2 (fresh store object, as after a restart) resolves.
  const paused = await createAgent({ provider: model, tools, store: makeStore() }).send(
    [{ type: 'text', text: 'Photo of the dent, file a claim' }, { type: 'image', image: png, mediaType: 'image/png' }],
    { sessionId: 'claim-1' });
  const resumed = await createAgent({ provider: model, tools, store: makeStore() }).approvals.resolve({ id: paused.approvalId, approved: true });
  const ok = seen instanceof Uint8Array && seen.length === png.length;
  console.log(`[${name}] ${resumed.finishReason}; image the model got after approval:`, ok ? `Uint8Array(${seen.length})` : JSON.stringify(seen));
  console.log(ok ? '  PASS' : '  FAIL: image bytes corrupted across the approval pause');
}
