import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMcpArgs, runMcp, startMcpServer } from './mcp';
import { LLMProviderRegistry } from '../providers/llm';
import { createMockProvider } from '../providers/mock';

beforeAll(() => {
  LLMProviderRegistry.register('mock', () => createMockProvider({ responses: ['hello'] }));
});

function writeSpec(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-mcp-test-'));
  const file = path.join(dir, 'agent.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ name: 'cli agent', prompt: 'p', provider: { type: 'mock', model: 'm' } })
  );
  return file;
}

describe('parseMcpArgs', () => {
  it('defaults to stdio-less defaults with the spec path', () => {
    expect(parseMcpArgs(['agent.yaml'])).toEqual({ configPath: 'agent.yaml', http: false, port: 3920, host: '127.0.0.1' });
  });

  it('reads --http, --port and --host in both flag styles', () => {
    expect(parseMcpArgs(['--http', '--port', '4000', '--host=0.0.0.0', 'a.json'])).toEqual({
      configPath: 'a.json',
      http: true,
      port: 4000,
      host: '0.0.0.0',
    });
  });

  it('explains how to fix a missing path or bad port', () => {
    expect(() => parseMcpArgs([])).toThrow(/spec file path is required/);
    expect(() => parseMcpArgs(['a.json', '--port', 'abc'])).toThrow(/--port must be an integer/);
  });
});

describe('startMcpServer', () => {
  it('serves a spec over HTTP', async () => {
    const server = await startMcpServer({ configPath: writeSpec(), http: true, port: 0, host: '127.0.0.1' });
    try {
      expect(server.agentToolName).toBe('cli_agent');
      expect(server.url).toMatch(/\/mcp$/);
    } finally {
      await server.close();
    }
  });
});

describe('runMcp', () => {
  it('returns 1 with a message when the spec is missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runMcp(['/does/not/exist.json', '--http', '--port', '0'])).toBe(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('lousho mcp with an agent directory (Eve CLI-F2)', () => {
  it('serves an agent directory instead of crashing with EISDIR', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-mcp-dir-'));
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ model: 'openai/gpt-4o-mini' }));
    fs.writeFileSync(path.join(dir, 'instructions.md'), 'Be brief.');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const server = await startMcpServer({ configPath: dir, http: true, port: 0, host: '127.0.0.1' });
    try {
      expect(server.url).toMatch(/\/mcp$/);
      expect(server.agentToolName).toBe(path.basename(dir).replace(/[^A-Za-z0-9_-]/g, '_'));
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  });

  it('prefixes failures with the command and never leaks a raw fs error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-mcp-empty-'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runMcp([dir, '--http', '--port', '0'])).toBe(1);
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toMatch(/^lousho mcp:|LOUSHO_/);
    expect(message).not.toMatch(/EISDIR/);
    error.mockRestore();
  });
});
