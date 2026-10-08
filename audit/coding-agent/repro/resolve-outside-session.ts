/**
 * Footgun probe (offline, mockModel): a session turn pauses on a gated
 * write_file. A "restarted" agent on the same fileStore resolves the approval
 * WITHOUT first opening the session (the docs warn to call resume() first).
 * What happens to the transcript and the turn checkpoint?
 *
 *   node coding-agent/repro/resolve-outside-session.ts   (or npx tsx)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgent, createFsTools, fileStore, MemoryWorkspace } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const storeDir = mkdtempSync(path.join(tmpdir(), 'lousho-footgun-'));
const workspace = new MemoryWorkspace({ files: { 'a.txt': 'old\n' } });
const tools = createFsTools(workspace, { needsApproval: { write_file: true } });
const makeAgent = (provider: ReturnType<typeof mockModel>) => createAgent({ provider, tools, store: fileStore(storeDir) });

// Process 1: pause inside a durable session turn.
const a1 = makeAgent(mockModel([{ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'new\n' } }] }, 'Wrote it.']));
const s1 = a1.session({ id: 'chat' });
const paused = await s1.send('update a.txt');
console.log('paused:', paused.finishReason, paused.approvalId);

// "Restarted" process that resolves WITHOUT the resume()/pending() dance.
const a2 = makeAgent(mockModel(['Resumed and wrote it.']));
console.log('a2 sees pending via get():', (await a2.approvals.get(paused.approvalId!))?.toolName);
const resolved = await a2.approvals.resolve({ id: paused.approvalId!, approved: true });
console.log('resolve result:', resolved.finishReason, JSON.stringify(resolved.text));

// Reopen the session and inspect what the transcript recorded.
const s2 = a2.session({ id: 'chat' });
const msgs = await s2.load();
console.log('transcript length:', msgs.length);
console.log('roles:', msgs.map((m) => m.role).join(','));
console.log('last texts:', msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 60)).join(' | '));
console.log('pending after resolve:', JSON.stringify(await s2.pending()));
console.log('workspace a.txt:', JSON.stringify(workspace.snapshot()['a.txt']));
