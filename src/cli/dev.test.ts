import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDevServer, DevServerHandle } from './dev';
import { LLMProviderRegistry } from '../providers/llm';
import { createMockProvider } from '../providers/mock';

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

function addressPort(h: DevServerHandle): number {
  const addr = h.server.address();
  if (addr && typeof addr === 'object') return addr.port;
  return h.port;
}
