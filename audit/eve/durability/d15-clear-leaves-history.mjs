// D15: session.clear() is documented as "the transcript, an interrupted
// turn's checkpoint ... are gone". Every committed turn's checkpoint HISTORY
// (full transcript copies, kept on purpose for agent.fork) survives clear(),
// and is resurrected by agent.fork('<id>.turn-<n>').
import { createAgent, defineTool, fileStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'eve-d15-'));
const tools = [defineTool({ name: 'lookup', description: 'lookup', input: z.object({}), execute: async () => 'record found' })];
const model = mockModel([(r) => r.messages.at(-1).role === 'tool' ? 'Noted.' : { toolCalls: [{ name: 'lookup', args: {} }] }], { onExhausted: 'repeat-last' });
const agent = createAgent({ provider: model, tools, store: fileStore(dir) });
const s = agent.session({ id: 'patient-9' });
await s.send('hello');
await s.send('My diagnosis is HIV-positive, please note it');
await s.send('thanks');
await s.clear();
console.log('after clear(): transcript =', JSON.stringify(await agent.session({ id: 'patient-9' }).load()));
const hist = readdirSync(join(dir, 'checkpoint-history'));
console.log('checkpoint-history files left:', hist);
const leaked = hist.some((f) => readFileSync(join(dir, 'checkpoint-history', f), 'utf8').includes('HIV-positive'));
console.log(leaked ? '  FAIL: cleared conversation content is still on disk' : '  PASS');
try {
  const fork = await agent.fork('patient-9.turn-4', { fromStep: 1 });
  const r = await agent.resume(fork.sessionId);
  console.log('agent.fork("patient-9.turn-4") after clear ->', fork.sessionId, '| resurrected user msg:', JSON.stringify(fork.checkpoint.messages.filter((m) => m.role === 'user').map((m) => m.content)));
} catch (e) { console.log('fork after clear ->', e.code ?? e.message); }
