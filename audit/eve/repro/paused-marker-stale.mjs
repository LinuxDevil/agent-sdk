// Eve-2 probe: stale <id>.paused.json across process restarts.
// Scenario: pause -> approve -> done. Marker left on disk. New process opens
// the same store: does the stale marker break resume/send/fork?
import { createAgent, defineTool, fileStore, MemorySessionStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'eve-stale-'));
const store = fileStore(dir);
const tools = [defineTool({
  name: 'restart', description: 'restart', input: z.object({}),
  needsApproval: true, execute: async () => 'restarted',
})];
const calling = (name) => ({ toolCalls: [{ name, id: `call_${name}` }] });

if (!process.argv[2]) {
  const agent = createAgent({ provider: mockModel([calling('restart'), 'done']), tools, store });
  const paused = await agent.session({ id: 'chat', store: new MemorySessionStore() }).send('go');
  await agent.approvals.resolve({ id: paused.approvalId, approved: true });
  console.log('setup done. dir =', dir, '| cps:', readdirSync(join(dir, 'checkpoints')));
} else {
  // "fresh process" - new agent instance over the same store
  const agent = createAgent({ provider: mockModel(['new turn ok']), tools, store });
  let r;
  try { r = `resume -> ${JSON.stringify(await agent.resume('chat'))}`; }
  catch (e) { r = `resume threw ${e.constructor.name}: ${e.message.slice(0, 90)}`; }
  console.log(r);
  try { r = `send -> ${(await agent.session({ id: 'chat' }).send('hi')).finishReason}`; }
  catch (e) { r = `send threw ${e.constructor.name}: ${e.message.slice(0, 90)}`; }
  console.log(r);
  console.log('cps:', readdirSync(join(dir, 'checkpoints')));
}
