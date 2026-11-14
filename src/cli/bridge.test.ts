import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runBridge } from './bridge';
import type { BridgeResponse } from '../bridge/protocol';

function io() {
  return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
}

describe('runBridge', () => {
  it('--help prints usage and exits 0 without touching the streams protocol', async () => {
    const streams = io();
    const code = await runBridge(['--help'], streams);
    expect(code).toBe(0);
    const out = streams.stdout.read()?.toString() ?? '';
    expect(out).toContain('Usage: lousho bridge');
    expect(out).toContain('bridge protocol (NDJSON)');
  });

  it('a positional argument is a usage error (exit 2)', async () => {
    const streams = io();
    const code = await runBridge(['extra'], streams);
    expect(code).toBe(2);
    expect(streams.stderr.read()?.toString()).toContain('lousho bridge');
  });

  it('serves hello over the given streams and resolves 0 on shutdown', async () => {
    const streams = io();
    const root = process.cwd();
    const done = runBridge([], { ...streams, root });
    const lines: string[] = [];
    const waiters: { id: number; resolve: (r: BridgeResponse) => void }[] = [];
    let buffer = '';
    streams.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        lines.push(line);
        const parsed = JSON.parse(line) as BridgeResponse;
        const waiter = waiters.find((w) => w.id === parsed.id);
        if (waiter !== undefined) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(parsed);
        }
      }
    });
    const response = (id: number) =>
      new Promise<BridgeResponse>((resolve, reject) => {
        waiters.push({ id, resolve });
        setTimeout(() => reject(new Error(`no response for id ${id}`)), 5000);
      });
    // hello must land before shutdown - the gate refuses anything earlier.
    const helloId = 1;
    const helloWait = response(helloId);
    streams.stdin.write(`${JSON.stringify({ id: helloId, method: 'hello', params: { protocol: 1, client: { name: 't', version: '0' } } })}\n`);
    expect(await helloWait).toMatchObject({ id: 1, result: { protocol: 1, sdkVersion: expect.any(String) } });
    const shutdownWait = response(2);
    streams.stdin.write(`${JSON.stringify({ id: 2, method: 'shutdown' })}\n`);
    expect(await shutdownWait).toMatchObject({ id: 2, result: { ok: true } });
    await expect(done).resolves.toBe(0);
  });
});
