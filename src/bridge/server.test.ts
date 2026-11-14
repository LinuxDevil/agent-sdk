import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { listBuiltinTools } from '../tools/catalog';
import { listModels } from '../models/catalog';
import { listGuardrails } from '../execution/guardrailCatalog';
import { listTriggerTypes } from '../spec/v2/triggerCatalog';
import { VERSION } from '../version';
import type { BridgeResponse } from './protocol';
import { serveBridge, type BridgeIo } from './server';

interface TestBridge {
  stdin: PassThrough;
  done: Promise<number>;
  /** Writes one request line. */
  send(method: string, params?: unknown, id?: number): number;
  /** The next stdout line that is a response for `id`. */
  response(id: number): Promise<BridgeResponse>;
  /** Every stdout line seen so far (responses and pushes). */
  lines(): string[];
}

/** A `serveBridge` session over PassThrough streams; `root` is a fresh temp project dir. */
function bridge(): TestBridge {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const root = mkdtempSync(path.join(tmpdir(), 'lousho-bridge-'));
  const pending: { id: number | null; resolve: (r: BridgeResponse) => void }[] = [];
  const seen: string[] = [];
  let buffer = '';
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      seen.push(line);
      const parsed = JSON.parse(line) as BridgeResponse & { id?: number | null };
      const waiter = pending.find((w) => w.id === parsed.id);
      if (waiter !== undefined) {
        pending.splice(pending.indexOf(waiter), 1);
        waiter.resolve(parsed);
      }
    }
  });
  let nextId = 1;
  const io: Required<BridgeIo> = { stdin, stdout, stderr, root };
  const done = serveBridge(io);
  return {
    stdin,
    done,
    send(method, params, id) {
      const rid = id ?? nextId++;
      stdin.write(`${JSON.stringify({ id: rid, method, params })}\n`);
      return rid;
    },
    response(id) {
      return new Promise<BridgeResponse>((resolve, reject) => {
        const existing = seen.map((l) => JSON.parse(l) as BridgeResponse).find((m) => 'id' in m && m.id === id);
        if (existing !== undefined) return resolve(existing);
        pending.push({ id, resolve });
        setTimeout(() => reject(new Error(`no response for id ${id}; saw ${seen.join(' | ')}`)), 5000);
      });
    },
    lines: () => [...seen],
  };
}

const result = (r: BridgeResponse) => ('result' in r ? r.result : undefined);
const error = (r: BridgeResponse) => ('error' in r ? r.error : undefined);

async function hello(b: TestBridge): Promise<void> {
  const r = await b.response(b.send('hello', { protocol: 1, client: { name: 'test', version: '0' } }));
  expect(error(r)).toBeUndefined();
}

describe('serveBridge', () => {
  it('answers hello with the SDK version, spec versions, protocol and catalog hash', async () => {
    const b = bridge();
    const r = await b.response(b.send('hello', { protocol: 1, client: { name: 'studio', version: '1.2.3' } }));
    expect(result(r)).toEqual({
      sdkVersion: VERSION,
      specVersions: [1, 2],
      protocol: 1,
      catalogHash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('refuses every method before a successful hello', async () => {
    const b = bridge();
    const r = await b.response(b.send('catalog'));
    expect(error(r)).toMatchObject({ code: 'LOUSHO_BRIDGE_NO_HELLO', message: "Send 'hello' first." });
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('rejects a hello for another protocol version with the supported list', async () => {
    const b = bridge();
    const r = await b.response(b.send('hello', { protocol: 2, client: { name: 'studio', version: '1' } }));
    expect(error(r)).toMatchObject({
      code: 'LOUSHO_BRIDGE_PROTOCOL',
      message: 'This SDK speaks bridge protocol 1; got 2.',
      details: { supported: [1] },
    });
    // A refused hello does not open the gate.
    const after = await b.response(b.send('catalog'));
    expect(error(after)?.code).toBe('LOUSHO_BRIDGE_NO_HELLO');
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('answers catalog with the four lists, matching the catalog functions', async () => {
    const b = bridge();
    await hello(b);
    const r = await b.response(b.send('catalog'));
    const catalog = result(r) as Record<string, unknown>;
    expect(catalog.tools).toEqual(listBuiltinTools());
    expect(catalog.models).toEqual(listModels());
    expect(catalog.guardrails).toEqual(listGuardrails());
    expect(catalog.triggers).toEqual(listTriggerTypes());
    // And hello's catalogHash fingerprints exactly that payload.
    const h = await b.response(b.send('hello', { protocol: 1, client: { name: 'studio', version: '1' } }));
    const expected = createHash('sha256').update(JSON.stringify(catalog)).digest('hex').slice(0, 16);
    expect((result(h) as { catalogHash: string }).catalogHash).toBe(expected);
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('compiles a minimal v2 spec without building an agent', async () => {
    const b = bridge();
    await hello(b);
    const r = await b.response(
      b.send('compile', {
        agentId: 'a',
        spec: { version: 2, name: 'a', model: 'mock/m', instructions: 'x', tools: [{ builtin: 'current_date' }] },
      })
    );
    expect(error(r)).toBeUndefined();
    expect(result(r)).toEqual({ modelLabel: 'mock/m', toolNamesByRef: [['current_date']], mcpServers: [] });
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('passes spec secret errors through and resolves them from params.secrets', async () => {
    const b = bridge();
    await hello(b);
    const spec = {
      version: 2,
      name: 'a',
      model: 'mock/m',
      instructions: 'x',
      mcpServers: { docs: { url: 'https://x.test/mcp', headers: { Authorization: { secret: 'X' } } } },
    };
    const missing = await b.response(b.send('compile', { agentId: 'a', spec }));
    expect(error(missing)?.code).toBe('LOUSHO_SPEC_SECRET_MISSING');
    const ok = await b.response(b.send('compile', { agentId: 'a', spec, secrets: { X: 'v' } }));
    expect(error(ok)).toBeUndefined();
    expect(result(ok)).toMatchObject({ mcpServers: ['docs'] });
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('answers LOUSHO_BRIDGE_BAD_JSON for a non-JSON line and keeps reading', async () => {
    const b = bridge();
    b.stdin.write('this is not json\n');
    // id:null responses match no waiter; read the raw line instead.
    await new Promise((r) => setTimeout(r, 50));
    const parsed = b.lines().map((l) => JSON.parse(l) as BridgeResponse);
    expect(parsed[0]).toMatchObject({ id: null, error: { code: 'LOUSHO_BRIDGE_BAD_JSON' } });
    await hello(b);
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('answers BAD_REQUEST for a missing id and for a non-string method', async () => {
    const b = bridge();
    b.stdin.write(`${JSON.stringify({ method: 'hello' })}\n`);
    b.stdin.write(`${JSON.stringify({ id: 7, method: 42 })}\n`);
    await new Promise((r) => setTimeout(r, 50));
    const parsed = b.lines().map((l) => JSON.parse(l) as BridgeResponse);
    expect(parsed[0]).toMatchObject({ id: null, error: { code: 'LOUSHO_BRIDGE_BAD_REQUEST' } });
    expect(parsed[1]).toMatchObject({ id: 7, error: { code: 'LOUSHO_BRIDGE_BAD_REQUEST' } });
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('answers UNKNOWN_METHOD for protocol methods this build does not implement', async () => {
    const b = bridge();
    await hello(b);
    const r = await b.response(b.send('run', { agentId: 'a', spec: {}, sessionId: 's', input: 'hi' }));
    expect(error(r)).toMatchObject({ code: 'LOUSHO_BRIDGE_UNKNOWN_METHOD', message: "Unknown method 'run'." });
    const bogus = await b.response(b.send('bogusMethod'));
    expect(error(bogus)?.code).toBe('LOUSHO_BRIDGE_UNKNOWN_METHOD');
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('answers BAD_PARAMS with path+message details for a malformed request', async () => {
    const b = bridge();
    const r = await b.response(b.send('hello', { protocol: 'one' }));
    expect(error(r)?.code).toBe('LOUSHO_BRIDGE_BAD_PARAMS');
    expect(error(r)?.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'protocol', message: expect.any(String) })])
    );
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('keeps console.log off stdout for the whole session', async () => {
    const b = bridge();
    console.log('a stray log line');
    await hello(b);
    await new Promise((r) => setTimeout(r, 20));
    for (const line of b.lines()) {
      expect(line).not.toContain('a stray log line');
      expect(() => JSON.parse(line)).not.toThrow();
    }
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('shutdown answers ok, then serveBridge resolves 0', async () => {
    const b = bridge();
    await hello(b);
    const r = await b.response(b.send('shutdown'));
    expect(result(r)).toEqual({ ok: true });
    await expect(b.done).resolves.toBe(0);
  });

  it('stdin end alone shuts the bridge down with code 0', async () => {
    const b = bridge();
    await hello(b);
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });
});
