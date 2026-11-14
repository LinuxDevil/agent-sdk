/**
 * W15b: bridge compatibility matrix. Proves the CURRENT Studio drives
 * `lousho bridge` from (a) the SDK in this checkout and (b) the oldest SDK
 * release Studio still supports (`MIN_BRIDGE_SDK_VERSION`), so an SDK
 * change that breaks protocol 1 - or a Studio change that needs a newer
 * bridge - fails a PR instead of a user.
 *
 * `LOUSHO_BRIDGE_SDK_DIR` points at the SDK under test (default: this
 * repo's root, i.e. the SDK in this commit). Each case builds a throwaway
 * workspace `<tmp>/ws` whose `node_modules/<sdk>` is a junction to that
 * directory, then drives every run through `WorkspaceHostSelector` +
 * `BridgeAgentHost` - the same path production traffic takes; no protocol
 * lines are written by hand.
 *
 * Scripted turns come from `scriptedProvider.mjs` (W11b's preload),
 * loaded with `nodeArgs: ['--import', ...]`; `LOUSHO_BRIDGE_SDK_DIR` in
 * the child env makes the preload import THAT SDK's dist entries (the
 * bare specifier would resolve Studio's own checkout - a different module
 * instance than the bridge child's).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSpecV2, Message } from '@linuxdevil/lousho';
import { WorkspaceHostSelector, type SelectHostDeps } from '../host/hostSelector';
import type { HostEvent, HostRunInput } from '../host/agentHost';
import { HostStartError } from '../host/bridgeAgentHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { InProcessAgentHost } from '../host/inProcessAgentHost';
import { workspaceRefFor } from '../workspace/workspaceId';
import { SecretsStore } from '../secretsStore';
import { VERSION } from '@linuxdevil/lousho';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SDK_DIR = process.env.LOUSHO_BRIDGE_SDK_DIR ?? REPO_ROOT;
const SCRIPTED_PROVIDER = fileURLToPath(new URL('./fixtures/scriptedProvider.mjs', import.meta.url));

interface SdkUnderTest {
  dir: string;
  name: string;
  version: string;
}

let sdk: SdkUnderTest;
let ws: string;
let secretsDir: string;
let secretsStore: SecretsStore;
let cleanups: Array<() => Promise<void>>;

beforeEach(() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SDK_DIR, 'package.json'), 'utf8')) as { name: string; version: string };
  sdk = { dir: SDK_DIR, name: pkg.name, version: pkg.version };
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w15b-ws-'));
  secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w15b-sec-'));
  secretsStore = new SecretsStore(secretsDir);
  cleanups = [];
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(secretsDir, { recursive: true, force: true });
});

/** `<tmp>/ws` with `package.json` and `node_modules/<sdk>` junctioned to the SDK under test. No `.env`. */
function makeWorkspace(): string {
  const root = path.join(ws, 'project');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'compat-ws', private: true }));
  const pkgDir = path.join(root, 'node_modules', ...sdk.name.split('/'));
  fs.mkdirSync(path.dirname(pkgDir), { recursive: true });
  fs.symlinkSync(sdk.dir, pkgDir, process.platform === 'win32' ? 'junction' : 'dir');
  return root;
}

function selectorDeps(root: string, options: { turns?: unknown; preload?: boolean } = {}): SelectHostDeps {
  return {
    inProcess: () =>
      new InProcessAgentHost({
        baseDir: root,
        checkpointStore: new FileCheckpointStore(root),
        approvalStore: new FileApprovalStore(root),
        secretsStore,
      }),
    secretsStore,
    collector: () => ({ url: 'http://127.0.0.1:9' }),
    studioVersion: VERSION,
    ...(options.preload === true && {
      nodeArgs: ['--import', pathToFileURL(SCRIPTED_PROVIDER).href],
      extraEnv: {
        SCRIPTED_TURNS: JSON.stringify(options.turns ?? ['ok']),
        LOUSHO_BRIDGE_SDK_DIR: sdk.dir,
      },
    }),
  };
}

async function readyHost(root: string, options: { turns?: unknown; preload?: boolean } = {}) {
  const selector = new WorkspaceHostSelector(workspaceRefFor(root), selectorDeps(root, options));
  cleanups.push(async () => {
    await selector.host.dispose();
  });
  const selection = await selector.ready();
  return { selector, selection, host: selector.host };
}

function inputFor(events: HostEvent[], spec: AgentSpecV2, input: HostRunInput['input']): HostRunInput {
  return { agentId: 'compat', spec, sessionId: 'compat-s', input, onEvent: (e) => events.push(e) };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settledEvents = (events: HostEvent[]) => events.filter((e) => e.type === 'settled');
const agentTypes = (events: HostEvent[]) => events.filter((e) => e.type === 'agent').map((e) => (e.type === 'agent' ? e.event.type : ''));

describe('bridge compat: current Studio x SDK under test', () => {
  it('case 1: ready() yields bridge mode, protocol 1, spec v2, and the SDK version', async () => {
    const root = makeWorkspace();
    const { selection, host } = await readyHost(root);
    expect(selection.mode).toBe('bridge');
    expect(selection.protocol).toBe(1);
    expect(selection.specVersions).toContain(2);
    expect(selection.sdkVersion).toBe(sdk.version);
    expect(host.kind).toBe('bridge');
  });

  it('case 2: catalog() returns four non-empty arrays of named items', async () => {
    const root = makeWorkspace();
    const { host } = await readyHost(root);
    const catalog = await host.catalog();
    for (const key of ['tools', 'models', 'guardrails', 'triggers'] as const) {
      expect(catalog[key].length, key).toBeGreaterThan(0);
      for (const item of catalog[key]) {
        // Trigger catalog entries key on `type`; tools/models/guardrails on `name`; some on `id`.
        const identifiable = item as { name?: unknown; id?: unknown; type?: unknown };
        expect(
          typeof identifiable.name === 'string' || typeof identifiable.id === 'string' || typeof identifiable.type === 'string',
          `${key} item has no name/id/type`
        ).toBe(true);
      }
    }
  });

  it('case 3: a minimal scripted spec runs to a settled stop', async () => {
    const root = makeWorkspace();
    const { host } = await readyHost(root, { preload: true, turns: ['hi there'] });
    const spec: AgentSpecV2 = { version: 2, name: 'compat', model: 'scripted/x', instructions: 'Say hi.' };
    const events: HostEvent[] = [];
    await host.start(inputFor(events, spec, 'hi'));
    await waitFor(() => settledEvents(events).length > 0, 'settled');
    const settled = settledEvents(events)[0]!;
    expect(settled.type === 'settled' && settled.result.finishReason).toBe('stop');
    expect(settled.type === 'settled' && (settled.result.text ?? '').length).toBeGreaterThan(0);
  });

  it('case 3b: the same minimal spec on mock/mock-1, without the preload', async () => {
    const spec: AgentSpecV2 = { version: 2, name: 'compat', model: 'mock/mock-1', instructions: 'Say hi.' };
    const root = makeWorkspace();
    const { host } = await readyHost(root);
    const events: HostEvent[] = [];
    await host.start(inputFor(events, spec, 'hi'));
    await waitFor(() => settledEvents(events).length > 0, 'settled');
    const types = agentTypes(events);
    expect(types).toContain('run.start');
    expect(types).toContain('run.done');
    const spanPhases = events.filter((e) => e.type === 'span').map((e) => (e.type === 'span' ? e.phase : ''));
    expect(spanPhases).toContain('start');
    expect(spanPhases).toContain('end');
    const settled = settledEvents(events)[0]!;
    expect(settled.type === 'settled' && settled.result.finishReason).toBe('stop');
    expect(settled.type === 'settled' && (settled.result.text ?? '').length).toBeGreaterThan(0);
  });

  it('case 4: chat continuation input settles', async () => {
    const spec: AgentSpecV2 = { version: 2, name: 'compat', model: 'mock/mock-1', instructions: 'Say hi.' };
    const root = makeWorkspace();
    const { host } = await readyHost(root);
    const events: HostEvent[] = [];
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    await host.start(inputFor(events, spec, messages));
    await waitFor(() => settledEvents(events).length > 0, 'settled');
    const settled = settledEvents(events)[0]!;
    expect(settled.type === 'settled').toBe(true);
  });

  it('case 5: an asked permission pauses, then resolveApproval continues to a stop', async () => {
    const root = makeWorkspace();
    const { host } = await readyHost(root, {
      preload: true,
      turns: [{ toolCalls: [{ name: 'current_date', args: {} }] }, 'done'],
    });
    const spec: AgentSpecV2 = {
      version: 2,
      name: 'compat',
      model: 'scripted/x',
      instructions: 'Say hi.',
      tools: [{ builtin: 'current_date' }],
      permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
    };
    const events: HostEvent[] = [];
    const run = await host.start(inputFor(events, spec, 'hi'));
    await waitFor(() => settledEvents(events).length > 0, 'first settle');
    const paused = settledEvents(events)[0]!;
    expect(paused.type === 'settled' && paused.result.finishReason).toBe('awaiting-approval');
    const pending = paused.type === 'settled' ? paused.result.pendingApproval : undefined;
    expect(pending).toBeDefined();
    const approvalId = (pending as { id: string }).id;

    await host.resolveApproval(run.runId, approvalId, { approved: true });
    await waitFor(() => settledEvents(events).length > 1, 'continuation settle');
    const done = settledEvents(events)[1]!;
    expect(done.type === 'settled' && done.result.finishReason).toBe('stop');
  });

  it('case 6: abort after the first agent event settles aborted', async () => {
    const root = makeWorkspace();
    const { host } = await readyHost(root, { preload: true, turns: [{ text: 'thinking', delayMs: 2_000 }] });
    const spec: AgentSpecV2 = { version: 2, name: 'compat', model: 'scripted/x', instructions: 'Say hi.' };
    const events: HostEvent[] = [];
    const run = await host.start(inputFor(events, spec, 'hi'));
    await waitFor(() => agentTypes(events).length > 0, 'first agent event', 15_000);
    await host.abort(run.runId, 'user');
    await waitFor(() => settledEvents(events).length > 0, 'aborted settle', 15_000);
    const settled = settledEvents(events)[0]!;
    expect(settled.type === 'settled' && settled.result.finishReason).toBe('aborted');
  });

  it('case 7: an unknown model rejects start with a LOUSHO_* HostStartError', async () => {
    const root = makeWorkspace();
    const { host } = await readyHost(root);
    const spec: AgentSpecV2 = { version: 2, name: 'compat', model: 'nope/x', instructions: 'Say hi.' };
    const events: HostEvent[] = [];
    const failure = await host.start(inputFor(events, spec, 'hi')).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HostStartError);
    expect((failure as HostStartError).code).toMatch(/^LOUSHO_/);
  });
});
