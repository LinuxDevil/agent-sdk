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

function addressPort(h: DevServerHandle): number {
  const addr = h.server.address();
  if (addr && typeof addr === 'object') return addr.port;
  return h.port;
}
