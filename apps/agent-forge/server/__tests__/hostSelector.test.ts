/**
 * W11b: `WorkspaceHostSelector` rows 1-7. Rows 1-2 decide from disk and
 * never spawn; rows 3-7 run the real `BridgeClient` handshake against
 * `fakeBridge.mjs` (installed as the workspace's `node_modules` SDK).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRef } from '../../shared/workspace';
import { BridgeAgentHost, HostReadOnlyError } from '../host/bridgeAgentHost';
import { envCollector, WorkspaceHostSelector, type SelectHostDeps } from '../host/hostSelector';
import { InProcessAgentHost } from '../host/inProcessAgentHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { MIN_BRIDGE_SDK_VERSION } from '../host/sdkCompat';
import { workspaceRefFor } from '../workspace/workspaceId';
import { SecretsStore } from '../secretsStore';

const FAKE_BRIDGE = fileURLToPath(new URL('../host/__tests__/fakeBridge.mjs', import.meta.url));

let dir: string;
let secretsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w11b-sel-'));
  secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w11b-sec-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(secretsDir, { recursive: true, force: true });
});

/** A workspace whose node_modules SDK's `bin/lousho.js` IS the fake bridge. */
function sdkWorkspace(root: string, sdkName = '@lousho/build-ai-agent'): string {
  const pkgDir = path.join(root, 'node_modules', ...sdkName.split('/'));
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, 'dist', 'cli'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: sdkName, version: '9.9.9-test' })
  );
  fs.copyFileSync(FAKE_BRIDGE, path.join(pkgDir, 'bin', 'lousho.js'));
  fs.writeFileSync(path.join(pkgDir, 'dist', 'cli', 'bridge.mjs'), '// built\n');
  return pkgDir;
}

function deps(root: string, extraEnv: Record<string, string> = {}, timeouts: Record<string, number> = {}): SelectHostDeps {
  return {
    inProcess: () =>
      new InProcessAgentHost({
        baseDir: root,
        checkpointStore: new FileCheckpointStore(root),
        approvalStore: new FileApprovalStore(root),
      }),
    secretsStore: new SecretsStore(secretsDir),
    collector: () => ({ url: 'http://127.0.0.1:9' }),
    studioVersion: '9.9.9-studio',
    clientOptions: { stderr: () => undefined, timeouts: { hello: 2_000, shutdown: 500, ...timeouts } },
    extraEnv: { FAKE_BRIDGE_REPORT_ENV: '1', ...extraEnv },
  };
}

const refFor = (root: string): WorkspaceRef => workspaceRefFor(root);

describe('WorkspaceHostSelector', () => {
  it('row 1: no SDK on disk -> in-process, info banner, no client, reports to observe', async () => {
    const root = path.join(dir, 'plain');
    fs.mkdirSync(root, { recursive: true });
    const selector = new WorkspaceHostSelector(refFor(root), deps(root));
    expect(selector.host).toBeInstanceOf(InProcessAgentHost);
    expect(selector.client).toBeUndefined();
    expect(selector.reportsToObserve).toBe(true);
    expect(selector.current()).toEqual({
      mode: 'in-process',
      sdkVersion: '9.9.9-studio',
      banner: {
        tone: 'info',
        text: "This project has no @lousho/build-ai-agent installed. Runs use Studio's built-in SDK 9.9.9-studio.",
      },
    });
    await expect(selector.ready()).resolves.toMatchObject({ mode: 'in-process' });
  });

  it('row 2: the SDK checkout itself, unbuilt -> in-process with the build hint', () => {
    const root = path.join(dir, 'sdk-src');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'lousho', version: '9.9.9' }));
    fs.writeFileSync(path.join(root, 'bin', 'lousho.js'), '// bin\n');
    const selector = new WorkspaceHostSelector(refFor(root), deps(root));
    expect(selector.host).toBeInstanceOf(InProcessAgentHost);
    expect(selector.client).toBeUndefined();
    expect(selector.current().banner).toEqual({
      tone: 'info',
      text: "This SDK checkout is not built, so runs use Studio's built-in SDK 9.9.9-studio. Run npm run build to use it.",
    });
  });

  it('row 3: bridge child without the command -> read-only with the update warning', async () => {
    const root = path.join(dir, 'ws');
    fs.mkdirSync(root, { recursive: true });
    sdkWorkspace(root);
    const selector = new WorkspaceHostSelector(refFor(root), deps(root, { FAKE_BRIDGE_MODE: 'unknown-command' }));
    expect(selector.host).toBeInstanceOf(BridgeAgentHost);
    expect(selector.client).toBeDefined();
    expect(selector.reportsToObserve).toBe(false);
    // Provisional snapshot before the handshake settles.
    expect(selector.current()).toMatchObject({ mode: 'bridge', sdkVersion: '9.9.9-test', banner: null });
    const settled = await selector.ready();
    expect(settled.mode).toBe('read-only');
    expect(settled.banner).toEqual({
      tone: 'warning',
      text: `Update @lousho/build-ai-agent in this project to ${MIN_BRIDGE_SDK_VERSION} or later to edit agents here.`,
    });
    await expect(selector.host.start({ agentId: 'a', spec: {} as never, sessionId: 's', input: 'hi', onEvent: () => {} })).rejects.toBeInstanceOf(HostReadOnlyError);
  });

  it('row 4: hello without spec v2 -> read-only with the same update warning', async () => {
    const root = path.join(dir, 'ws');
    fs.mkdirSync(root, { recursive: true });
    sdkWorkspace(root);
    const selector = new WorkspaceHostSelector(refFor(root), deps(root, { FAKE_BRIDGE_SPEC_VERSIONS: '[1]' }));
    const settled = await selector.ready();
    expect(settled.mode).toBe('read-only');
    expect(settled.banner?.tone).toBe('warning');
    expect(settled.banner?.text).toContain(MIN_BRIDGE_SDK_VERSION);
  });

  it('row 5: protocol newer than Studio -> read-only with the newer-SDK warning', async () => {
    const root = path.join(dir, 'ws');
    fs.mkdirSync(root, { recursive: true });
    sdkWorkspace(root);
    const selector = new WorkspaceHostSelector(
      refFor(root),
      deps(root, { FAKE_BRIDGE_PROTOCOL: '2', FAKE_BRIDGE_SDK_VERSION: '99.0.0' })
    );
    const settled = await selector.ready();
    expect(settled.mode).toBe('read-only');
    expect(settled.banner).toEqual({
      tone: 'warning',
      text: "This project's @lousho/build-ai-agent 99.0.0 is newer than this Studio understands. Update Studio to edit agents here.",
    });
  });

  it('row 6: a good hello -> bridge mode, no banner, hello sdkVersion wins', async () => {
    const root = path.join(dir, 'ws');
    fs.mkdirSync(root, { recursive: true });
    sdkWorkspace(root);
    const onChange = vi.fn();
    const selector = new WorkspaceHostSelector(refFor(root), deps(root, { FAKE_BRIDGE_SDK_VERSION: '8.8.8' }));
    selector.onChange(onChange);
    const settled = await selector.ready();
    expect(settled).toMatchObject({ mode: 'bridge', sdkVersion: '8.8.8', banner: null });
    expect(selector.current().mode).toBe('bridge');
    expect(onChange).toHaveBeenCalled();
    // The child env: observe target + workspace id + bridge flag, no studio token.
    // The fake reports env on stderr after answering hello, so poll for it.
    const deadline = Date.now() + 5_000;
    let envLines: string[] = [];
    while (Date.now() < deadline && envLines.length === 0) {
      envLines = selector.client!.recentStderr().filter((l) => l.startsWith('env '));
      if (envLines.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    try {
    const env = Object.fromEntries(envLines.map((l) => l.slice(4).split(/=(.*)/s).slice(0, 2) as [string, string]));
    expect(env.LOUSHO_OBSERVE).toBe('http://127.0.0.1:9');
    expect(env.LOUSHO_OBSERVE_PROJECT).toBe(refFor(root).id);
    expect(env.LOUSHO_BRIDGE).toBe('1');
    expect(env.LOUSHO_STUDIO_TOKEN).toBe('<unset>');
    } finally {
      await selector.client!.stop();
    }
  });

  it('row 7: handshake failure -> bridge mode with the restart banner', async () => {
    const root = path.join(dir, 'ws');
    fs.mkdirSync(root, { recursive: true });
    sdkWorkspace(root);
    const selector = new WorkspaceHostSelector(
      refFor(root),
      deps(root, { FAKE_BRIDGE_MODE: 'silent' }, { hello: 300 })
    );
    const settled = await selector.ready();
    expect(settled.mode).toBe('bridge');
    expect(settled.banner).toEqual({
      tone: 'danger',
      text: "This project's agent process keeps stopping. Check the Studio terminal for its output, then restart it.",
      action: 'restart',
    });
    await selector.client!.stop();
  });

  it('envCollector reads LOUSHO_OBSERVE_URL/TOKEN per call', () => {
    const prevUrl = process.env.LOUSHO_OBSERVE_URL;
    const prevToken = process.env.LOUSHO_OBSERVE_TOKEN;
    try {
      process.env.LOUSHO_OBSERVE_URL = 'http://127.0.0.1:9999/';
      process.env.LOUSHO_OBSERVE_TOKEN = 'tok';
      expect(envCollector()).toEqual({ url: 'http://127.0.0.1:9999', token: 'tok' });
      delete process.env.LOUSHO_OBSERVE_TOKEN;
      expect(envCollector()).toEqual({ url: 'http://127.0.0.1:9999' });
    } finally {
      if (prevUrl === undefined) delete process.env.LOUSHO_OBSERVE_URL;
      else process.env.LOUSHO_OBSERVE_URL = prevUrl;
      if (prevToken === undefined) delete process.env.LOUSHO_OBSERVE_TOKEN;
      else process.env.LOUSHO_OBSERVE_TOKEN = prevToken;
    }
  });
});
