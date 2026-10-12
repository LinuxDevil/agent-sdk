// Phase arg required: run "node marker-two-phase.mjs <dir> setup" then "... resume"
import { createAgent, defineTool, fileStore, MemorySessionStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [dir, phase] = process.argv.slice(2);
const store = fileStore(dir);
const tools = [defineTool({
  name: 'restart', description: 'restart', input: z.object({}),
  needsApproval: true, execute: async () => 'restarted',
})];
const calling = (name) => ({ toolCalls: [{ name, id: `call_${name}` }] });

if (phase === 'setup') {
  const agent = createAgent({ provider: mockModel([calling('restart'), 'done']), tools, store });
  const paused = await agent.session({ id: 'chat', store: new MemorySessionStore() }).send('go');
  await agent.approvals.resolve({ id: paused.approvalId, approved: true });
  console.log('setup done | cps:', readdirSync(join(dir, 'checkpoints')));
} else {
  const agent = createAgent({ provider: mockModel(['new turn ok']), tools, store });
  try { console.log('resume ->', JSON.stringify(await agent.resume('chat'))); }
  catch (e) { console.log('resume threw', e.constructor.name, e.message.slice(0, 90)); }
  try { console.log('send ->', (await agent.session({ id: 'chat' }).send('hi')).finishReason); }
  catch (e) { console.log('send threw', e.constructor.name, e.message.slice(0, 90)); }
  console.log('cps after:', readdirSync(join(dir, 'checkpoints')));
}
