// Eve-2 probe: does the <id>.paused.json marker get cleaned up after the
// approval resolves? A lingering marker = permanently locked session.
import { createAgent, defineTool, fileStore, MemorySessionStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'eve-marker-'));
const store = fileStore(dir);
const tools = [defineTool({
  name: 'restart', description: 'restart', input: z.object({}),
  needsApproval: true, execute: async () => 'restarted',
})];
const calling = (name) => ({ toolCalls: [{ name, id: `call_${name}` }] });
const agent = createAgent({ provider: mockModel([calling('restart'), 'done', 'third turn ok']), tools, store });

const paused = await agent.session({ id: 'chat', store: new MemorySessionStore() }).send('restart it');
console.log('paused:', paused.finishReason, '| cps:', readdirSync(join(dir, 'checkpoints')));

const resolved = await agent.approvals.resolve({ id: paused.approvalId, approved: true });
console.log('resolved ->', resolved.finishReason, '| cps after:', readdirSync(join(dir, 'checkpoints')));

// Can the session run new turns now?
let outcome;
try {
  const r = await agent.session({ id: 'chat' }).send('next turn');
  outcome = `resolved finishReason=${r.finishReason}`;
} catch (e) { outcome = `threw ${e.constructor.name}: ${e.message.slice(0, 100)}`; }
console.log('session.send after resolve ->', outcome);
