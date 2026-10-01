import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDevServer, DevServerHandle } from './dev';
import { LLMProviderRegistry } from '../providers/llm';
import { createMockProvider } from '../providers/mock';
import { mockModel } from '../testing';
import { collectLocalImports, detectTarget } from './devReload';

const MOCK_RESPONSE = 'This is the mock dev-server response.';

beforeAll(() => {
  LLMProviderRegistry.register('mock', () =>
    createMockProvider({ responses: [MOCK_RESPONSE] })
  );
});

function writeConfig(dir: string, overrides: Record<string, unknown> = {}) {
  const configPath = path.join(dir, 'agent.config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      name: 'dev-test-agent',
      prompt: 'You are a helpful test agent.',
      provider: { type: 'mock', model: 'mock-model-1' },
      ...overrides,
    })
  );
  return configPath;
}

let handle: DevServerHandle | undefined;
afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
});

describe('startDevServer', () => {
  it('serves the chat UI on GET / with an id="msg" input', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-dev-'));
    const configPath = writeConfig(dir);
    handle = await startDevServer(configPath, 0);

    const res = await fetch(`http://localhost:${addressPort(handle)}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('id="msg"');
    expect(html).toContain('id="send"');
    expect(html).toContain('id="log"');
  });

  it('a realistic message round-trip via the UI page\'s own /chat call produces a reply', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-dev-'));
    const configPath = writeConfig(dir);
    handle = await startDevServer(configPath, 0);
    const port = addressPort(handle);

    // Confirm the page itself posts to /chat (what its inline script does),
    // then drive that exact same call to confirm the round trip works.
    const page = await (await fetch(`http://localhost:${port}/`)).text();
    expect(page).toContain("fetch('/chat'");

    const res = await fetch(`http://localhost:${port}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello from the UI' }),
    });
    const json = await res.json();
    expect(json.text).toBe(MOCK_RESPONSE);
  });

  it('responds 200 ok on GET /health', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-dev-'));
    const configPath = writeConfig(dir);
    handle = await startDevServer(configPath, 0);

    const res = await fetch(`http://localhost:${addressPort(handle)}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('POST /chat returns the mock provider response', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-dev-'));
    const configPath = writeConfig(dir);
    handle = await startDevServer(configPath, 0);

    const res = await fetch(`http://localhost:${addressPort(handle)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.text).toBe(MOCK_RESPONSE);
  });

  it('rejects a POST /chat body larger than the size cap with 413', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-dev-'));
    const configPath = writeConfig(dir);
    handle = await startDevServer(configPath, 0);
    const port = addressPort(handle);

    // 1MB cap - send a body comfortably over it.
    const oversized = JSON.stringify({ message: 'x'.repeat(2 * 1024 * 1024) });

    const res = await fetch(`http://localhost:${port}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    });
    expect(res.status).toBe(413);
  });

  it('binds to 127.0.0.1 (localhost-only) by default, not all interfaces', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-dev-'));
    const configPath = writeConfig(dir);
    handle = await startDevServer(configPath, 0);

    const addr = handle.server.address();
    expect(addr && typeof addr === 'object' ? addr.address : addr).toBe('127.0.0.1');
  });

  it('rejects with a clear message when the port is already in use', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-dev-'));
    const configPath = writeConfig(dir);
    handle = await startDevServer(configPath, 0);
    const port = addressPort(handle);

    await expect(startDevServer(configPath, port)).rejects.toThrow(
      new RegExp(`port ${port} is already in use`)
    );
  });
});

describe('hot reload (LOU-H8)', () => {
  it('picks up an edited prompt without restarting the server/port, and keeps working on an invalid edit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-dev-reload-'));
    const configPath = writeConfig(dir);
    handle = await startDevServer(configPath, 0);
    const port = addressPort(handle);
    const originalServer = handle.server;

    const first = await (
      await fetch(`http://localhost:${port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      })
    ).json();
    expect(first.text).toBe(MOCK_RESPONSE);

    // Register a second mock provider variant so the reload is observable.
    const UPDATED_RESPONSE = 'Updated after hot reload.';
    LLMProviderRegistry.register('mock', () =>
      createMockProvider({ responses: [UPDATED_RESPONSE] })
    );

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        name: 'dev-test-agent',
        prompt: 'You are an UPDATED helpful test agent.',
        provider: { type: 'mock', model: 'mock-model-1' },
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 400));

    const second = await (
      await fetch(`http://localhost:${port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi again' }),
      })
    ).json();
    expect(second.text).toBe(UPDATED_RESPONSE);

    // Same server/port the whole time - no restart happened.
    expect(handle.server).toBe(originalServer);
    expect(addressPort(handle)).toBe(port);

    // Now write an invalid edit (missing required 'prompt') - the server
    // must keep serving the last-good (UPDATED_RESPONSE) config rather
    // than crashing.
    fs.writeFileSync(configPath, JSON.stringify({ provider: { type: 'mock', model: 'x' } }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    const third = await (
      await fetch(`http://localhost:${port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'still there?' }),
      })
    ).json();
    expect(third.text).toBe(UPDATED_RESPONSE);
  });
});

describe('agent directories and TS modules (LOU-D31)', () => {
  const fixtures = path.join(__dirname, '__fixtures__');
  const copies: string[] = [];

  /** A scratch copy of a fixture next to it, so the fixture's relative imports still resolve. */
  function copyFixture(name: string): string {
    const copy = fs.mkdtempSync(path.join(fixtures, `tmp-${name}-`));
    copies.push(copy);
    fs.cpSync(path.join(fixtures, name), copy, { recursive: true });
    return copy;
  }
  afterEach(() => {
    for (const copy of copies.splice(0)) fs.rmSync(copy, { recursive: true, force: true });
  });

  const url = (h: DevServerHandle, route: string) => `http://localhost:${addressPort(h)}${route}`;
  const chat = async (h: DevServerHandle, message = 'hi') =>
    (
      await fetch(url(h, '/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
    ).json();
  const status = async (h: DevServerHandle) => (await fetch(url(h, '/dev/status'))).json();
  async function waitFor(check: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('timed out waiting for the dev server');
  }
  const systemOf = (call: { messages: readonly { role: string; content: unknown }[] }) =>
    String(call.messages.find((m) => m.role === 'system')?.content);

  it('detects a spec, a directory and a module by path type and extension, with coded errors otherwise', () => {
    expect(detectTarget(path.join(fixtures, 'dev-agent')).kind).toBe('dir');
    expect(detectTarget(path.join(fixtures, 'dev-module', 'agent.ts')).kind).toBe('module');
    expect(detectTarget('agent.yaml').kind).toBe('spec');
    expect(() => detectTarget(path.join(fixtures, 'nope.ts'))).toThrow(/LOUSHY_CONFIG_INVALID/);
    expect(() => detectTarget(path.join(fixtures, 'dev-agent', 'instructions.md'))).toThrow(
      /LOUSHY_SPEC_UNSUPPORTED_FORMAT/
    );
  });

  it('serves an agent directory with loadAgentDir', async () => {
    const provider = mockModel(['dir says hi']);
    handle = await startDevServer(path.join(fixtures, 'dev-agent'), 0, '127.0.0.1', { overrides: { provider } });

    expect((await chat(handle)).text).toBe('dir says hi');
    expect(systemOf(provider.calls[0])).toContain('You are the dev fixture agent.');
    expect(provider.calls[0].tools?.map((t) => t.function.name)).toEqual(['ping']);
    expect(await status(handle)).toMatchObject({ kind: 'dir', reloads: 0, error: null });
  });

  it('serves a TS module whose default export is a SimpleAgent, and accepts a config export', async () => {
    handle = await startDevServer(path.join(fixtures, 'dev-module', 'agent.ts'), 0);
    expect((await chat(handle)).text).toBe('module says hi');
    expect(await status(handle)).toMatchObject({ kind: 'module' });
    await handle.close();

    const provider = mockModel(['config says hi']);
    handle = await startDevServer(path.join(fixtures, 'dev-module', 'config.ts'), 0, '127.0.0.1', {
      overrides: { provider },
    });
    expect((await chat(handle)).text).toBe('config says hi');
    expect(systemOf(provider.calls[0])).toContain('config-export agent');
  });

  it('rejects a module that exports no agent with a coded error', async () => {
    await expect(startDevServer(path.join(fixtures, 'dev-module', 'bad.ts'), 0)).rejects.toThrow(
      /LOUSHY_CONFIG_INVALID/
    );
  });

  it('reloads when instructions.md or a tool changes, without restarting the server', async () => {
    const dir = copyFixture('dev-agent');
    const provider = mockModel(['ok', 'ok', 'ok']);
    handle = await startDevServer(dir, 0, '127.0.0.1', { overrides: { provider }, debounceMs: 20 });
    const server = handle.server;
    await chat(handle);

    fs.writeFileSync(path.join(dir, 'instructions.md'), 'You are the EDITED agent.\n');
    await waitFor(async () => (await status(handle!)).reloads >= 1);
    await chat(handle);
    expect(systemOf(provider.calls[1])).toContain('EDITED');

    const toolFile = path.join(dir, 'tools', 'ping.ts');
    fs.writeFileSync(toolFile, fs.readFileSync(toolFile, 'utf8').replace("'ping'", "'ping_v2'"));
    await waitFor(async () => (await status(handle!)).reloads >= 2);
    await chat(handle);
    expect(provider.calls[2].tools?.map((t) => t.function.name)).toEqual(['ping_v2']);
    expect(handle.server).toBe(server);
  });

  it('keeps the previous agent after a failed reload and reports the error', async () => {
    const dir = copyFixture('dev-agent');
    const provider = mockModel(['ok', 'ok', 'ok']);
    handle = await startDevServer(dir, 0, '127.0.0.1', { overrides: { provider }, debounceMs: 20 });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    fs.writeFileSync(path.join(dir, 'tools', 'ping.ts'), 'export default (');
    await waitFor(async () => (await status(handle!)).error !== null);
    expect((await status(handle)).reloads).toBe(0);
    expect(await chat(handle)).toMatchObject({ text: 'ok' });
    expect(systemOf(provider.calls[0])).toContain('You are the dev fixture agent.');
    expect(quiet).toHaveBeenCalledWith(expect.stringContaining('keeping the previous agent'));

    // Fixing the file recovers and clears the error.
    fs.copyFileSync(path.join(fixtures, 'dev-agent', 'tools', 'ping.ts'), path.join(dir, 'tools', 'ping.ts'));
    await waitFor(async () => (await status(handle!)).error === null);
    expect((await status(handle)).reloads).toBe(1);
    quiet.mockRestore();
  });

  it('reloads a module when it or a local import changes', async () => {
    const dir = copyFixture('dev-module');
    const file = path.join(dir, 'agent.ts');
    const local = collectLocalImports(file).filter((f) => f.startsWith(dir));
    expect(local.map((f) => path.basename(f)).sort()).toEqual(['agent.ts', 'greeting.ts']);

    handle = await startDevServer(file, 0, '127.0.0.1', { debounceMs: 20 });
    expect((await chat(handle)).text).toBe('module says hi');

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('module says hi', 'edited reply'));
    await waitFor(async () => (await status(handle!)).reloads >= 1);
    expect((await chat(handle)).text).toBe('edited reply');

    // An edit to an imported file triggers a reload too.
    fs.appendFileSync(path.join(dir, 'greeting.ts'), '// touched\n');
    await waitFor(async () => (await status(handle!)).reloads >= 2);
  });
});

function addressPort(h: DevServerHandle): number {
  const addr = h.server.address();
  if (addr && typeof addr === 'object') return addr.port;
  return h.port;
}
