import { createAgent, defineTool, fileStore } from '@lousho/build-ai-agent';
import { SqliteStore } from '@lousho/build-ai-agent/sqlite';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
const base = join(process.cwd(), 'eve/docs-ui/docs-a/.tmp-xp'); rmSync(base, { recursive: true, force: true });
for (const kind of ['file', 'sqlite'] as const) {
  let runs = 0;
  const tool = defineTool({ name: 'send_email', description: 'd', input: z.object({ to: z.string() }), needsApproval: true, execute: async () => { runs++; return 'sent'; } });
  const mkStore = () => (kind === 'file' ? fileStore(join(base, 'f')) : new SqliteStore(join(base, 's.db')));
  const A = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'send_email', args: { to: 'x' } }] }]), tools: [tool], store: mkStore() });
  const paused = await A.send('go');
  const B = createAgent({ provider: mockModel(['done B']), tools: [tool], store: mkStore() });
  const C = createAgent({ provider: mockModel(['done C']), tools: [tool], store: mkStore() });
  console.log(kind, 'B.list():', (await B.approvals.list()).length, 'B.get(id):', !!(await B.approvals.get(paused.approvalId!)));
  const res = await Promise.allSettled([B.approvals.resolve({ id: paused.approvalId!, approved: true }), C.approvals.resolve({ id: paused.approvalId!, approved: true })]);
  console.log(kind, 'concurrent resolve:', res.map((r) => (r.status === 'fulfilled' ? 'OK ' + r.value.text : 'ERR ' + (r.reason as any).code)), 'tool runs:', runs, 'A.list after:', (await A.approvals.list()).length, 'A.get after:', await A.approvals.get(paused.approvalId!), 'A.resolve:', await A.approvals.resolve({ id: paused.approvalId!, approved: true }).then(() => 'OK', (e: any) => e.code));
}
