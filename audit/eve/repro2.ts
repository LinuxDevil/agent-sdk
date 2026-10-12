import { createAgent, memoryStore } from '../../src/index';
import { defineTool } from '../../src/tools/defineTool';
import { mockModel } from '../../src/testing/index';
import { z } from 'zod';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string() }),
  needsApproval: true,
  execute: async ({ to }) => `sent to ${to}`,
});

async function r4_sessionBudgetLostOnResume() {
  console.log('=== R4: session limits dropped on approval-resumed turn ===');
  const store = memoryStore();
  const lookup = defineTool({
    name: 'lookup', description: 'look up', input: z.object({ q: z.string() }),
    execute: async ({ q }) => `result ${q}`,
  });
  const model = mockModel([
    { toolCalls: [{ name: 'send_email', args: { to: 'c@x.com' } }], usage: { inputTokens: 100, outputTokens: 100 } },
    { toolCalls: [{ name: 'lookup', args: { q: 'x' } }], usage: { inputTokens: 100, outputTokens: 100 } },
    'final answer',
  ]);
  const agent = createAgent({ provider: model, tools: [sendEmail, lookup], store });
  // session limit: 300 tokens total. Step 1 spends 200 and pauses.
  const s = agent.session({ id: 'sess4', limits: { maxTokens: 300 } });
  const paused = await s.send('email then lookup');
  console.log('paused:', paused.finishReason, paused.approvalId);
  const res = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
  console.log('resumed finishReason:', res.finishReason, 'steps:', res.steps, 'tokens:', res.usage.totalTokens);
  console.log('model calls made:', model.calls.length);
  // With the session budget the continuation should have stopped at 400>300 as 'budget-exceeded'.
  const s2 = agent.session({ id: 'sess4b', limits: { maxTokens: 300 } });
  const p2 = await s2.send('a');
  console.log('control (no pause path) ...');
}

async function r6_forkIdNotSession() {
  console.log('\n=== R6: agent.fork id cannot be opened as a session ===');
  const store = memoryStore();
  const agent = createAgent({ provider: mockModel(['a', 'b', 'c']), store });
  await agent.send('one', { sessionId: 'job' });
  const fork = await agent.fork('job', { fromStep: 1 });
  console.log('fork id:', fork.sessionId);
  try {
    agent.session({ id: fork.sessionId });
    console.log('session() accepted the fork id');
  } catch (e) {
    console.log('session() threw:', (e as { code?: string }).code, (e as Error).message.slice(0, 90));
  }
}

async function r7_corruptCheckpoint() {
  console.log('\n=== R7: corrupt checkpoint file -> raw SyntaxError ===');
  const { fileStore } = await import('../../src/storage/fileStore');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'lousho-'));
  const store = fileStore(dir);
  writeFileSync(join(dir, 'checkpoints'), '', { flag: 'w' }) // no-op safety
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  writeFileSync(join(dir, 'checkpoints', 's1.json'), '{oops not json');
  try {
    await store.checkpoints.load('s1');
  } catch (e) {
    console.log('load threw:', (e as Error).name, '-', (e as Error).message.slice(0, 80));
  }
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'sessions', 's2.json'), '{oops not json');
  try {
    await store.sessions.load('s2');
  } catch (e) {
    console.log('sessions.load threw:', (e as Error).name, '-', (e as Error).message.slice(0, 80), 'code:', (e as {code?:string}).code);
  }
}

async function r8_pendingOfSharedId() {
  console.log('\n=== R8: agent.resume on a raw turn id bypasses the session queue ===');
  const store = memoryStore();
  const tool = defineTool({ name: 'slow', description: 'slow', input: z.object({}), execute: async () => { await new Promise(r => setTimeout(r, 30)); return 'slow done'; } });
  const agent = createAgent({
    provider: mockModel([{ toolCalls: [{ name: 'slow' }] }, 'turn done'], { onExhausted: 'repeat-last' }),
    tools: [tool],
    store,
  });
  // Simulate crash: write an in-progress checkpoint under 'sessx.turn-0' that a raw resume can grab.
  const res = await agent.resume('sessx.turn-0');
  console.log('resume of turn id:', res === null ? 'null' : res.finishReason);
}

async function main() {
  await r4_sessionBudgetLostOnResume().catch((e) => console.log('R4 FAILED', e));
  await r6_forkIdNotSession().catch((e) => console.log('R6 FAILED', e));
  await r7_corruptCheckpoint().catch((e) => console.log('R7 FAILED', e));
  await r8_pendingOfSharedId().catch((e) => console.log('R8 FAILED', e));
}
main();
