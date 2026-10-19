/**
 * The deployed node server finishes the runs a crash left interrupted once it
 * listens (`agent.recover()`): only the in-flight step runs again, runs paused
 * on an approval are left alone, and `LOUSHO_RECOVER_ON_START=0` turns it off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { PropagatingToolError } from '../execution/AgentExecutor';
import { fileStore } from '../storage/fileStore';
import { memoryStore } from '../storage/agentStore';
import { mockModel, type MockTurn } from '../testing';
import { createDeployedServer, type DeployedServerOptions } from './nodeServer';
import type { SimpleAgent } from '../createAgent';

const calling = (name: string): MockTurn => ({ toolCalls: [{ name, id: `call_${name}` }] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const closers: (() => Promise<unknown>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * `charge` counts its calls (the step that completed before the crash);
 * `crash` dies the first time it runs, as the process would mid-tool, and
 * waits on `gate` after that; `send_email` needs an approval.
 */
function tools(runs: Record<string, number>, gate: Promise<void> = Promise.resolve()): DefinedTool[] {
  runs.charge ??= 0;
  runs.crash ??= 0;
  runs.send_email ??= 0;
  return [
    defineTool({ name: 'charge', description: 'charge', input: z.object({}), execute: async () => `charged ${++runs.charge}` }),
    defineTool({
      name: 'crash',
      description: 'crash',
      input: z.object({}),
      execute: async () => {
        if (++runs.crash === 1) throw new PropagatingToolError('process died');
        await gate;
        return 'ok';
      },
    }),
    defineTool({ name: 'send_email', description: 'email', input: z.object({}), needsApproval: true, execute: async () => `sent ${++runs.send_email}` }),
  ];
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-server-recover-'));
  dirs.push(dir);
  return dir;
}

/** Leaves session `id` of the store in `dir` with a turn interrupted mid-tool: `charge` ran, `crash` died. */
async function interruptedTurn(dir: string, id: string, runs: Record<string, number>): Promise<void> {
  const before = createAgent({ provider: mockModel([calling('charge'), calling('crash')]), tools: tools(runs), store: fileStore(dir) });
  await expect(before.session({ id }).send('charge, then finish')).rejects.toThrow('process died');
  expect(await before.pending()).toEqual([expect.objectContaining({ sessionId: id, kind: 'session', status: 'in-progress' })]);
}

async function serve(agent: SimpleAgent, options: DeployedServerOptions) {
  closers.push(() => agent.close());
  const deployed = createDeployedServer(agent, options);
  closers.push(() => deployed.shutdown({ timeoutMs: 200 }));
  await new Promise<void>((done) => deployed.server.listen(0, '127.0.0.1', done));
  return { ...deployed, url: `http://127.0.0.1:${(deployed.server.address() as AddressInfo).port}` };
}

interface SessionView {
  messages: { role: string; content?: unknown }[];
  pending: { status: string } | null;
}

async function sessionView(url: string, id: string): Promise<SessionView> {
  return (await (await fetch(`${url}/chat/${id}`)).json()) as SessionView;
}

describe('createDeployedServer() crash recovery', () => {
  it('resumes a turn interrupted mid-tool once the server listens, re-running only the in-flight step', async () => {
    const dir = tempDir();
    const runs: Record<string, number> = {};
    await interruptedTurn(dir, 'chat-1', runs);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const agent = createAgent({ provider: mockModel(['all done']), tools: tools(runs), store: fileStore(dir) });
    const { url } = await serve(agent, { env: {}, recovery: { intervalMs: 20 } });

    await vi.waitFor(async () => expect((await sessionView(url, 'chat-1')).pending).toBeNull(), { timeout: 3000 });
    const view = await sessionView(url, 'chat-1');
    // One turn: one user message, ending with the reply the resume produced.
    expect(view.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(view.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'all done' });
    // The completed charge did not run again; only the call that was mid-flight did.
    expect(runs).toMatchObject({ charge: 1, crash: 2 });
    expect(await agent.pending()).toEqual([]);
    expect(log).toHaveBeenCalledWith('lousho server: resuming 1 interrupted run(s)');
    expect(log).toHaveBeenCalledWith("lousho server: recovered interrupted run 'chat-1'");
    expect(error).not.toHaveBeenCalled();
  });

  it('leaves a turn paused on an approval alone', async () => {
    const dir = tempDir();
    const runs: Record<string, number> = {};
    const before = createAgent({ provider: mockModel([calling('send_email')]), tools: tools(runs), store: fileStore(dir) });
    const paused = await before.session({ id: 'chat-approval' }).send('email Sam');
    expect(paused.finishReason).toBe('awaiting-approval');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const agent = createAgent({ provider: mockModel(['should not run']), tools: tools(runs), store: fileStore(dir) });
    const { url } = await serve(agent, { env: {}, recovery: { intervalMs: 10 } });
    await sleep(150);

    expect(runs.send_email).toBe(0);
    expect((await sessionView(url, 'chat-approval')).pending).toMatchObject({ status: 'awaiting-approval' });
    expect(await agent.pending()).toEqual([expect.objectContaining({ sessionId: 'chat-approval', status: 'awaiting-approval', approvalId: paused.approvalId })]);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('interrupted run'));
  });

  it.each([
    ['LOUSHO_RECOVER_ON_START=0', { env: { LOUSHO_RECOVER_ON_START: '0' }, recovery: { intervalMs: 10 } }],
    ['LOUSHO_RECOVER_ON_START=false', { env: { LOUSHO_RECOVER_ON_START: 'false' }, recovery: { intervalMs: 10 } }],
    ['recovery: false', { env: {}, recovery: false }],
  ] as const)('does nothing with %s', async (_name, options) => {
    const dir = tempDir();
    const runs: Record<string, number> = {};
    await interruptedTurn(dir, 'chat-off', runs);

    const agent = createAgent({ provider: mockModel(['all done']), tools: tools(runs), store: fileStore(dir) });
    const { url } = await serve(agent, options);
    await sleep(150);

    expect(runs).toMatchObject({ charge: 1, crash: 1 });
    expect((await sessionView(url, 'chat-off')).pending).toMatchObject({ status: 'in-progress' });
  });

  it('starts quietly with nothing to recover: an empty memory store, or no checkpoint store at all', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const withStore = createAgent({ provider: mockModel(['hi']), store: memoryStore() });
    const withoutStore = createAgent({ provider: mockModel(['hi']) });
    for (const agent of [withStore, withoutStore]) {
      const { url } = await serve(agent, { env: {}, recovery: { intervalMs: 10 } });
      await sleep(50);
      expect((await fetch(`${url}/health`)).status).toBe(200);
    }
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('runs a resend that races the recovery after the recovered turn, so no tool of that turn runs twice', async () => {
    const dir = tempDir();
    const runs: Record<string, number> = {};
    await interruptedTurn(dir, 'chat-race', runs);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const agent = createAgent({ provider: mockModel(['all done', 'resent reply']), tools: tools(runs, gate), store: fileStore(dir) });
    const { url } = await serve(agent, { env: {}, recovery: { intervalMs: 20 } });
    // Recovery is now mid-tool, resuming the interrupted turn.
    await vi.waitFor(() => expect(runs.crash).toBe(2), { timeout: 3000 });

    // The client resends without an Idempotency-Key: the session's turns of this process run one at a time.
    const resending = fetch(`${url}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'chat-race', input: 'charge, then finish' }) });
    await sleep(100);
    release();
    const resend = await resending;
    expect(resend.status).toBe(200);
    expect(await resend.text()).toContain('resent reply');

    expect(runs).toMatchObject({ charge: 1, crash: 2 });
    const { messages, pending } = await sessionView(url, 'chat-race');
    expect(pending).toBeNull();
    expect(messages.filter((message) => message.role === 'tool')).toHaveLength(2);
    expect(messages.filter((message) => message.role === 'assistant' && message.content).map((message) => message.content)).toEqual(['all done', 'resent reply']);
  });

  it('answers a resend with the same Idempotency-Key that races the recovery without running the turn again', async () => {
    const dir = tempDir();
    const runs: Record<string, number> = {};
    const headers = { 'content-type': 'application/json', 'idempotency-key': 'msg-1' };
    const body = JSON.stringify({ sessionId: 'chat-key', input: 'charge, then finish' });
    const before = createAgent({ provider: mockModel([calling('charge'), calling('crash')]), tools: tools(runs), store: fileStore(dir) });
    const first = await serve(before, { env: {}, recovery: false });
    await (await fetch(`${first.url}/chat`, { method: 'POST', headers, body })).text();
    expect(runs).toMatchObject({ charge: 1, crash: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const agent = createAgent({ provider: mockModel(['all done', 'not used']), tools: tools(runs, gate), store: fileStore(dir) });
    const { url } = await serve(agent, { env: {}, recovery: { intervalMs: 20 } });
    await vi.waitFor(() => expect(runs.crash).toBe(2), { timeout: 3000 });

    const resending = fetch(`${url}/chat`, { method: 'POST', headers, body });
    await sleep(100);
    release();
    const resend = await resending;
    expect(resend.status).toBe(200);
    expect(await resend.text()).toContain('"text":"all done"');
    expect(runs).toMatchObject({ charge: 1, crash: 2 });
    const { messages, pending } = await sessionView(url, 'chat-key');
    expect(pending).toBeNull();
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });
});
