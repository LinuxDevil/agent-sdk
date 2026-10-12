import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileStore } from '../../src/storage/fileStore';
import { createAgent, memoryStore } from '../../src/index';
import { defineTool } from '../../src/tools/defineTool';
import { mockModel } from '../../src/testing/index';
import { z } from 'zod';
import type { KVStore } from '../../src/deploy/types';

async function r7_corruptCheckpoint() {
  console.log('=== R7: corrupt file store -> raw SyntaxError ===');
  const dir = mkdtempSync(join(tmpdir(), 'lousho-'));
  const store = fileStore(dir);
  const cdir = join(dir, 'checkpoints');
  if (!existsSync(cdir)) mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 's1.json'), '{oops not json');
  try {
    await store.checkpoints.load('s1');
  } catch (e) {
    console.log('checkpoints.load threw:', (e as Error).name, '-', String((e as Error).message).slice(0, 70), 'code:', (e as {code?:string}).code);
  }
  const sdir = join(dir, 'sessions');
  if (!existsSync(sdir)) mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, 's2.json'), '{oops not json');
  try {
    await store.sessions.load('s2');
  } catch (e) {
    console.log('sessions.load threw:', (e as Error).name, '-', String((e as Error).message).slice(0, 70), 'code:', (e as {code?:string}).code);
  }
}

async function r9_kvDoubleResolve() {
  console.log('\n=== R9: KVApprovalStore double-resolve (non-atomic get+delete) ===');
  // emulate an eventually-consistent / non-atomic KV
  const map = new Map<string, string>();
  const kv: KVStore = {
    get: async (k) => { await new Promise(r => setTimeout(r, 5)); return map.get(k) ?? null; },
    put: async (k, v) => { map.set(k, v); },
    delete: async (k) => { map.delete(k); },
    list: async () => [],
  };
  const { kvStore } = await import('../../src/deploy/kvStore');
  const store = kvStore(kv);
  const sendEmail = defineTool({
    name: 'send_email', description: 'x', input: z.object({ to: z.string() }),
    needsApproval: true, execute: async ({ to }) => `sent to ${to}`,
  });
  let toolRuns = 0;
  const tool2 = defineTool({
    name: 'send_email', description: 'x', input: z.object({ to: z.string() }),
    needsApproval: true, execute: async ({ to }) => { toolRuns++; return `sent to ${to}`; },
  });
  const agent = createAgent({
    provider: mockModel([
      { toolCalls: [{ name: 'send_email', args: { to: 'e@x.com' } }] },
      'done',
      'done2',
    ], { onExhausted: 'repeat-last' }),
    tools: [tool2],
    store,
  });
  const s = agent.session({ id: 'sessk' });
  const paused = await s.send('go');
  console.log('paused:', paused.finishReason);
  // two concurrent resolves
  const [a, b] = await Promise.allSettled([
    agent.approvals.resolve({ id: paused.approvalId!, approved: true }),
    agent.approvals.resolve({ id: paused.approvalId!, approved: true }),
  ]);
  console.log('resolve A:', a.status === 'fulfilled' ? a.value.finishReason : (a.reason as Error).name + ' ' + (a.reason as {code?:string}).code);
  console.log('resolve B:', b.status === 'fulfilled' ? b.value.finishReason : (b.reason as Error).name + ' ' + (b.reason as {code?:string}).code);
  console.log('tool executions:', toolRuns);
}

async function main() {
  await r7_corruptCheckpoint().catch((e) => console.log('R7 FAILED', e));
  await r9_kvDoubleResolve().catch((e) => console.log('R9 FAILED', e));
}
main();
