import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { CASSETTES_ENV, DRIFT_DIR_ENV, cassettePath, driftCassettePath, withEvalCassettes } from './cassettes';
import type { EvalResult } from './evalResult';

afterEach(() => {
  vi.unstubAllEnvs();
});

function evalFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-cassettes-')), 'refund.eval.ts');
}

/** Runs one "case": sends a message to an agent on `provider`, returns a minimal result. */
async function runCase(file: string, provider: ReturnType<typeof mockModel>): Promise<{ result: EvalResult; reply: string }> {
  let reply = '';
  const result = await withEvalCassettes({ file, name: 'Refund flow', label: 'Order #42' }, async () => {
    reply = (await createAgent({ provider, prompt: 'You handle refunds.' }).send('Refund 42')).text;
    return { name: 'Refund flow', case: 'Order #42', tags: [], passed: true, assertions: [], durationMs: 0, steps: 1, toolCalls: [] };
  });
  return { result, reply };
}

describe('cassettePath', () => {
  it('names cassettes deterministically next to the eval file', () => {
    expect(cassettePath('/p/evals/refund.eval.ts', 'Refund flow', 'Order #42')).toBe(
      path.join('/p/evals', '__cassettes__', 'refund-flow', 'order-42.json')
    );
    expect(cassettePath('/p/a.eval.ts', 'e', undefined, 1)).toBe(path.join('/p', '__cassettes__', 'e', 'default.2.json'));
  });

  it('maps a committed cassette to a stable drift location', () => {
    expect(driftCassettePath('/tmp/d', '/p/x.json')).toBe(driftCassettePath('/tmp/d', '/p/x.json'));
    expect(driftCassettePath('/tmp/d', '/p/x.json')).not.toBe(driftCassettePath('/tmp/d', '/p/y.json'));
  });
});

describe('withEvalCassettes', () => {
  it('runs the case untouched when loushy eval set no mode', async () => {
    const file = evalFile();
    const { result, reply } = await runCase(file, mockModel(['live']));
    expect(reply).toBe('live');
    expect(result.cassettes).toBeUndefined();
    expect(fs.existsSync(path.join(path.dirname(file), '__cassettes__'))).toBe(false);
  });

  it('records the case, then replays it without calling the provider', async () => {
    const file = evalFile();
    vi.stubEnv(CASSETTES_ENV, 'record');
    const recorded = await runCase(file, mockModel(['recorded reply']));
    const cassette = cassettePath(file, 'Refund flow', 'Order #42');
    expect(recorded.result.cassettes).toEqual([cassette]);
    expect(fs.existsSync(cassette)).toBe(true);

    vi.stubEnv(CASSETTES_ENV, 'replay');
    const replayed = await runCase(file, mockModel([]));
    expect(replayed.reply).toBe('recorded reply');
  });

  it('fails a replay without a cassette with the --record command, and runs live in auto mode', async () => {
    const file = evalFile();
    vi.stubEnv(CASSETTES_ENV, 'replay');
    await expect(runCase(file, mockModel(['x']))).rejects.toThrow(/no cassette for "Refund flow \[Order #42\]".*npx loushy eval --record/);
    vi.stubEnv(CASSETTES_ENV, 'auto');
    expect((await runCase(file, mockModel(['live']))).reply).toBe('live');
  });

  it('records into the drift dir instead of over the committed cassette', async () => {
    const file = evalFile();
    const driftDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-drift-'));
    vi.stubEnv(CASSETTES_ENV, 'record');
    vi.stubEnv(DRIFT_DIR_ENV, driftDir);
    const { result } = await runCase(file, mockModel(['again']));
    const committed = cassettePath(file, 'Refund flow', 'Order #42');
    expect(result.cassettes).toEqual([committed]);
    expect(fs.existsSync(committed)).toBe(false);
    expect(fs.existsSync(driftCassettePath(driftDir, committed))).toBe(true);
  });
});
