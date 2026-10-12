// Eve probe: while a turn is durably paused for approval, does
// agent.send(input, { sessionId }) refuse - or run a second turn that
// shares the session id (and checkpoint namespace)?
import { createAgent, defineTool, fileStore, MemorySessionStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'eve-overlap-'));
const store = fileStore(dir);
const tools = [defineTool({
  name: 'restart', description: 'restart a service', input: z.object({}),
  needsApproval: true, execute: async () => 'restarted',
})];
const calling = (name) => ({ toolCalls: [{ name, id: `call_${name}` }] });
const agent = createAgent({ provider: mockModel([calling('restart'), 'second-turn-ok']), tools, store });

// Channel-shaped session pauses on 'chat'.
const paused = await agent.session({ id: 'chat', store: new MemorySessionStore() }).send('restart it');
console.log('paused:', paused.finishReason, '| checkpoints:', readdirSync(join(dir, 'checkpoints')));

// Now send NEW work to the same session id via the agent-level send.
let outcome;
try {
  const result = await agent.send('unrelated work', { sessionId: 'chat' });
  outcome = `resolved finishReason=${result.finishReason} steps=${result.steps}`;
} catch (error) {
  outcome = `threw ${error.constructor.name}: ${error.message}`;
}
console.log('agent.send("chat") while paused ->', outcome);
console.log('checkpoints now:', readdirSync(join(dir, 'checkpoints')));
