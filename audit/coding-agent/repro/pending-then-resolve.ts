/**
 * Follow-up probe: does session.pending() alone bind the approval to the
 * session (so resolve() records the turn), or is the throwing resume() call
 * required?
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgent, createFsTools, fileStore, MemoryWorkspace } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const storeDir = mkdtempSync(path.join(tmpdir(), 'lousho-footgun2-'));
const workspace = new MemoryWorkspace({ files: { 'a.txt': 'old\n' } });
const tools = createFsTools(workspace, { needsApproval: { write_file: true } });
const makeAgent = (provider: ReturnType<typeof mockModel>) => createAgent({ provider, tools, store: fileStore(storeDir) });

const a1 = makeAgent(mockModel([{ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'new\n' } }] }, 'Wrote it.']));
const paused = await a1.session({ id: 'chat' }).send('update a.txt');
console.log('paused:', paused.finishReason);

const a2 = makeAgent(mockModel(['Resumed and wrote it.']));
const s2 = a2.session({ id: 'chat' });
console.log('pending():', JSON.stringify(await s2.pending())); // no resume() call
const resolved = await a2.approvals.resolve({ id: paused.approvalId!, approved: true });
console.log('resolve:', resolved.finishReason, JSON.stringify(resolved.text));
console.log('transcript length:', (await s2.load()).length);
