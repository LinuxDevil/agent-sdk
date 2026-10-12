// Eve probe 2: durable-session send() while a channel turn is paused.
// beforeTurn -> resumePending derives <id>.turn-<transcript.length> from the
// DURABLE transcript, so a paused channel turn-0 is invisible to it too.
import { createAgent, defineTool, fileStore, MemorySessionStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'eve-overlap2-'));
const store = fileStore(dir);
const tools = [defineTool({
  name: 'restart', description: 'restart a service', input: z.object({}),
  needsApproval: true, execute: async () => 'restarted',
})];
const calling = (name) => ({ toolCalls: [{ name, id: `call_${name}` }] });

// Seed durable transcript for 'chat' (as the approval continuation does).
await createAgent({ provider: mockModel(['done']), store }).session({ id: 'chat' }).send('hi');

// Channel-shaped pause: memory transcript -> chat.turn-0 awaiting-approval.
const channel = createAgent({ provider: mockModel([calling('restart'), 'resumed']), tools, store });
const paused = await channel.session({ id: 'chat', store: new MemorySessionStore() }).send('restart it');
console.log('paused:', paused.finishReason, '| checkpoints:', readdirSync(join(dir, 'checkpoints')));

// Durable session.send() on the same id while paused.
let outcome;
try {
  const result = await channel.session({ id: 'chat' }).send('more work');
  outcome = `resolved finishReason=${result.finishReason}`;
} catch (error) {
  outcome = `threw ${error.constructor.name}: ${error.message.slice(0, 120)}`;
}
console.log('session.send("chat") while paused ->', outcome);
console.log('checkpoints now:', readdirSync(join(dir, 'checkpoints')));
console.log('transcript length:', JSON.parse(readFileSync(join(dir, 'sessions', 'chat.json'), 'utf8')).length);
