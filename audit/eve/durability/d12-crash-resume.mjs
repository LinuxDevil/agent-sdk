// Crash-mid-turn: a child process is killed (process.exit) during the model
// call that follows a side-effecting tool; a fresh process then resumes.
// Checks: tool not re-run, transcript complete, and what send() does.
import { createAgent, defineTool, fileStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { appendFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [, , role, dir] = process.argv;
const ledger = (d) => join(d, 'ledger.txt');
const tools = (d) => [defineTool({ name: 'transfer', description: 'transfer money', input: z.object({ amount: z.number() }),
  execute: async ({ amount }) => { appendFileSync(ledger(d), `transfer ${amount}\n`); return 'done'; } })];
if (role === 'child') {
  const model = mockModel([{ toolCalls: [{ name: 'transfer', args: { amount: 100 } }] }, async () => { process.exit(137); }]);
  await createAgent({ provider: model, tools: tools(dir), store: fileStore(dir) }).session({ id: 'acct-1' }).send('send 100 to bob');
} else {
  const d = mkdtempSync(join(tmpdir(), 'eve-d12-'));
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child', d], { stdio: 'inherit' });
  console.log('child exit code:', child.status, '| ledger after crash:', JSON.stringify(readFileSync(ledger(d), 'utf8')));
  const model = mockModel([(req) => `Sent. (model saw ${req.messages.filter((m) => m.role === 'tool').length} tool result)`, 'ok second']);
  const agent = createAgent({ provider: model, tools: tools(d), store: fileStore(d) });
  const s = agent.session({ id: 'acct-1' });
  console.log('pending() in new process:', JSON.stringify(await s.pending()));
  const r = await agent.resume('acct-1');
  console.log('agent.resume ->', r?.finishReason, JSON.stringify(r?.text));
  console.log('stale object s.load():', (await s.load()).length, 'msgs  <- see d13');
  console.log('ledger after resume:', JSON.stringify(readFileSync(ledger(d), 'utf8')), '| transcript (fresh object):', (await agent.session({ id: 'acct-1' }).load()).map((m) => m.role).join(','));
}
