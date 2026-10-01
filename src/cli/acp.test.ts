import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { mockModel } from '../testing';
import { parseAcpArgs, runAcp } from './acp';

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

async function run(args: string[], lines: string[], overrides?: Parameters<typeof runAcp>[1] extends infer T ? (T extends { overrides?: infer O } ? O : never) : never) {
  const stdin = new PassThrough();
  const out = sink();
  const err = sink();
  stdin.end(`${lines.join('\n')}\n`);
  const code = await runAcp(args, { stdin, stdout: out.stream, stderr: err.stream, overrides });
  return { code, out: out.text(), err: err.text() };
}

describe('loushy acp', () => {
  it('parses its path and --model, and rejects a missing path or an unknown flag with the usage', () => {
    expect(parseAcpArgs(['agent.yaml', '--model=openai/gpt-4o'])).toEqual({ path: 'agent.yaml', model: 'openai/gpt-4o' });
    expect(parseAcpArgs(['--help'])).toEqual({ path: '', help: true });
    for (const args of [[], ['a.yaml', '--bogus']]) expect(() => parseAcpArgs(args)).toThrow(/LOUSHY_CONFIG_INVALID/);
  });

  it('prints the usage for --help and fails on stderr for a bad path', async () => {
    expect((await run(['--help'], [])).out).toContain('Usage: loushy acp');
    const bad = await run([path.join(__dirname, '__fixtures__', 'nope', 'agent.ts')], []);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('LOUSHY_CONFIG_INVALID');
    expect(bad.out).toBe('');
  });

  it('serves an agent directory on stdio: stdout carries only JSON-RPC lines', async () => {
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '.', mcpServers: [] } }),
    ];
    const { code, out } = await run([path.join(__dirname, '__fixtures__', 'dev-agent')], lines, { provider: mockModel([]) });
    expect(code).toBe(0);
    const messages = out.trim().split('\n').map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    expect(messages.map((m) => m.id)).toEqual([1, 2]);
    expect(messages[0].result.protocolVersion).toBe(1);
    expect(messages[1].result.sessionId).toMatch(/^acp-/);
  });
});
