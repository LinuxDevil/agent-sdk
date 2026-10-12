// Eve finding repro: agent.resume(id) silently resolves null for a paused
// channel-driven session once a durable transcript of the same id exists.
//
// Channels (mountChannels with no store option) run sessions on a
// MemorySessionStore transcript while checkpoints/approvals land in the
// agent's durable fileStore. The approval-continuation path, however,
// commits the finished transcript through the durable store. After the
// first completed channel turn, sessions/<id>.json has length L>0 while
// every later channel turn checkpoints <id>.turn-0 again (the memory
// transcript is always empty). agent.resume(<id>) then derives
// <id>.turn-L from the durable transcript, finds nothing, and returns
// null - silently ignoring a real awaiting-approval checkpoint.
//
// Run from audit/: node eve/repro/resume-divergence.mjs
import { createAgent, defineTool, fileStore, MemorySessionStore, SessionAwaitingApprovalError } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'eve-resume-'));
const store = fileStore(dir);
const tools = [defineTool({
  name: 'restart',
  description: 'restart a service',
  input: z.object({}),
  needsApproval: true,
  execute: async () => 'restarted',
})];
const calling = (name) => ({ toolCalls: [{ name, id: `call_${name}` }] });

// Phase A: a completed turn on a DURABLE session 'chat' (as the approval
// continuation writes it). sessions/chat.json now holds 2 messages.
const done = await createAgent({ provider: mockModel(['All done.']), store })
  .session({ id: 'chat' }).send('hello');
console.log('phase A: completed turn ->', done.finishReason);
const transcript = JSON.parse(readFileSync(join(dir, 'sessions', 'chat.json'), 'utf8'));
console.log('durable transcript length:', transcript.length);

// Phase B: a CHANNEL-style session - memory transcript, durable checkpoints.
// Same pattern as channelCore.runTurn: agent.session({ id, store: memory }).
const channel = createAgent({ provider: mockModel([calling('restart'), 'resumed']), tools, store });
const paused = await channel.session({ id: 'chat', store: new MemorySessionStore() }).send('restart it');
console.log('phase B: channel turn ->', paused.finishReason, 'approvalId:', paused.approvalId);
const cpDir = join(dir, 'checkpoints');
console.log('checkpoint files:', readdirSync(cpDir));

// The bug: resume() must refuse (the turn awaits approval); it returns null.
let outcome;
try {
  const result = await channel.resume('chat');
  outcome = `resolved with ${result === null ? 'null' : JSON.stringify(result.finishReason)}`;
} catch (error) {
  outcome = `threw ${error.constructor.name}${error instanceof SessionAwaitingApprovalError ? ' (correct)' : ': ' + error.message}`;
}
console.log('agent.resume("chat") ->', outcome);
console.log(outcome.includes('SessionAwaitingApprovalError') ? 'PASS: resume refused' : 'FAIL: pending approval checkpoint silently ignored');
