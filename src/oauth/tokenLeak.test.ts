/**
 * N9a: a token in `AgentStore.tokens` never shows up anywhere a run writes.
 * A tool reads the stored token (as N9b's `ctx.getToken()` will) and uses it;
 * then every output of the run is scanned for the token values: agent events,
 * the session transcript, checkpoints and their history, the trace file, the
 * recorded cassette, console output, the store's own files, and the errors of
 * a run whose token read fails (wrong key).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, recordReplay } from '../testing';
import { fileTraceExporter } from '../traces';
import { fileStore } from '../storage/fileStore';
import type { AgentEvent } from '../execution/agentEvents';
import type { AgentStore } from '../storage/agentStore';
import { generateTokenKey, type TokenOwner } from './index';
import { SENTINEL_ACCESS, SENTINEL_REFRESH, sentinelToken } from './tokenStore.contract';

const APP: TokenOwner = { owner: 'app' };
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lousho-oauth-leak-'));
  dirs.push(dir);
  return dir;
}

/** Every file under `dir`, concatenated. */
function readTree(dir: string): string {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .map((path) => (statSync(path).isDirectory() ? readTree(path) : readFileSync(path, 'utf8')))
    .join('\n');
}

function captureConsole(): string[] {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
  }
  return lines;
}

function expectNoToken(where: string, text: string): void {
  expect(text.length, `${where} is empty, so the scan proves nothing`).toBeGreaterThan(0);
  expect(text, where).not.toContain(SENTINEL_ACCESS);
  expect(text, where).not.toContain(SENTINEL_REFRESH);
}

/** A tool that calls an API with the stored token and returns only the answer. */
function listRepos(store: Required<AgentStore>) {
  return defineTool({
    name: 'list_repos',
    description: 'Lists the repositories of the connected GitHub account',
    input: z.object({}),
    execute: async () => {
      const token = await store.tokens.get('github', APP);
      const authorization = `Bearer ${token?.accessToken}`; // what a real tool would send
      return authorization.length > 7 ? 'You have 3 repositories.' : 'Not connected.';
    },
  });
}

describe('OAuth tokens stay out of run outputs (N9a)', () => {
  it('a tool that uses a stored token leaks it into no event, transcript, checkpoint, trace, cassette, log or file', async () => {
    const dir = tempDir();
    const logs = captureConsole();
    const key = generateTokenKey();
    const writer = fileStore(join(dir, 'store'), { tokenKey: key });
    await writer.tokens.set('github', APP, sentinelToken());
    const { store, events, result, cassette, checkpoints } = await runWith(dir, key);

    expectNoToken('events', JSON.stringify(events));
    expectNoToken('transcript', JSON.stringify(await store.sessions.load('chat')));
    expectNoToken('result', JSON.stringify(result));
    expectNoToken('trace files', readTree(join(dir, 'traces')));
    expectNoToken('cassette', readFileSync(cassette, 'utf8'));
    expect(checkpoints.length).toBeGreaterThan(1); // one per step, the tool result included
    expectNoToken('checkpoints', JSON.stringify(checkpoints));
    expectNoToken('store files', readTree(join(dir, 'store')));
    expectNoToken('token list', JSON.stringify(await store.tokens.list()));
    expect(logs.join('\n')).not.toContain(SENTINEL_ACCESS);
    expect(logs.join('\n')).not.toContain(SENTINEL_REFRESH);
    // The tool did read the real token: the stored one is intact.
    expect((await store.tokens.get('github', APP))?.accessToken).toBe(SENTINEL_ACCESS);
    expect(JSON.stringify(events)).toContain('You have 3 repositories.');
  });

  it('a failed token read (wrong key) surfaces an error that names the provider, not the token', async () => {
    const dir = tempDir();
    const logs = captureConsole();
    const writer = fileStore(join(dir, 'store'), { tokenKey: generateTokenKey() });
    await writer.tokens.set('github', APP, sentinelToken());
    const { store, events, result, cassette, checkpoints } = await runWith(dir, generateTokenKey());

    const everything = [JSON.stringify(events), JSON.stringify(result), JSON.stringify(checkpoints), JSON.stringify(await store.sessions.load('chat')), readTree(join(dir, 'traces')), readFileSync(cassette, 'utf8'), logs.join('\n')].join('\n');
    expect(everything).toContain('LOUSHO_TOKEN_DECRYPT_FAILED');
    expect(everything).toContain('provider \\"github\\"');
    expectNoToken('outputs of the failed run', everything);
  });
});

/** Run the agent once against the token store in `dir`, reading with `readKey`. */
async function runWith(dir: string, readKey: string) {
  const store = fileStore(join(dir, 'store'), { tokenKey: readKey });
  const checkpoints: unknown[] = [];
  const save = store.checkpoints.save.bind(store.checkpoints);
  store.checkpoints.save = async (id, checkpoint) => {
    checkpoints.push(structuredClone(checkpoint));
    await save(id, checkpoint);
  };
  const events: AgentEvent[] = [];
  const cassette = join(dir, 'cassette.json');
  const provider = recordReplay(
    mockModel([{ toolCalls: [{ name: 'list_repos', id: 'call_1', args: {} }] }, { text: 'You have 3 repositories.' }]),
    { cassette, mode: 'record' }
  );
  const agent = createAgent({
    provider,
    tools: [listRepos(store)],
    store,
    exporter: fileTraceExporter({ dir: join(dir, 'traces') }),
    captureContent: true,
    onEvent: (event) => events.push(event),
  });
  const result = await agent.session({ id: 'chat' }).send('Which repositories do I have?');
  return { store, events, result, cassette, checkpoints };
}

