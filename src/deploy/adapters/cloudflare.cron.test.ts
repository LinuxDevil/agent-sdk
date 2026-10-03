/**
 * LOU-P9: cron triggers of the spec become `[triggers] crons` of the generated
 * wrangler.toml, and the built Worker bundle's `scheduled()` runs them.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { SDKError } from '../../execution/errors';
import type { KVBinding } from '../kvCheckpointStore';
import { CloudflareWorkerAdapter, findNodeBuiltinReferences, workerCrons, wranglerTomlSource } from './cloudflare';
import { CHECKPOINT_KV_BINDING } from '../checkpointBinding';
import { withBuildLock } from '../buildLock.testkit';

const SPEC = {
  name: 'cron-agent',
  prompt: 'You are a scheduled agent.',
  provider: { type: 'mock', model: 'mock-1' },
};
const trigger = (extra: Record<string, unknown>) => ({ type: 'cron', name: 'nightly', input: 'Run.', ...extra });

describe('wrangler.toml crons', () => {
  it('writes deduplicated 5-field crons under [triggers]', () => {
    const toml = wranglerTomlSource({
      ...SPEC,
      triggers: [
        trigger({ cron: '0 9 * * MON' }),
        trigger({ name: 'again', cron: '0 9  * * MON' }),
        trigger({ name: 'hourly', cron: '*/30 * * * *' }),
        { type: 'webhook' },
      ],
    });
    expect(toml).toContain('[triggers]\ncrons = ["0 9 * * MON", "*/30 * * * *"]');
  });

  it('writes no [triggers] section without cron triggers', () => {
    expect(wranglerTomlSource(SPEC)).not.toContain('[triggers]');
    expect(wranglerTomlSource({ ...SPEC, triggers: [{ type: 'webhook' }] })).not.toContain('[triggers]');
  });

  it.each([
    ['a 6-field seconds expression', { cron: '0 0 9 * * *' }],
    ['a timezone', { cron: '0 9 * * *', timezone: 'Europe/Paris' }],
    ['a shortcut', { cron: '@daily' }],
    ['a numeric day-of-week', { cron: '0 9 * * 1' }],
  ])('fails with a coded SDK error naming the trigger for %s', (_label, extra) => {
    let thrown: unknown;
    try {
      workerCrons({ ...SPEC, triggers: [trigger(extra)] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SDKError);
    expect((thrown as SDKError).code).toBe('LOUSHO_SCHEDULE_INVALID');
    expect((thrown as SDKError).message).toContain("'nightly'");
  });

  it('scaffold() fails before writing anything for an unsupported expression', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cf-cron-bad-'));
    const specPath = path.join(dir, 'agent.json');
    fs.writeFileSync(specPath, JSON.stringify({ ...SPEC, triggers: [trigger({ cron: '0 0 9 * * *' })] }));
    await expect(CloudflareWorkerAdapter.scaffold(specPath, path.join(dir, 'out'))).rejects.toThrow(/nightly/);
    expect(fs.existsSync(path.join(dir, 'out', 'wrangler.toml'))).toBe(false);
  });
});

function fakeKV(): KVBinding & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (key) => data.get(key) ?? null, put: async (key, value) => void data.set(key, value), delete: async (key) => void data.delete(key) };
}

describe('built Worker bundle scheduled()', () => {
  let outDir: string;
  let plainDir: string;
  const spec = {
    ...SPEC,
    triggers: [trigger({ name: 'report', cron: '0 9 * * MON', input: 'Weekly report.' }), trigger({ name: 'tick', cron: '*/5 * * * *' })],
  };

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cf-cron-'));
    const build = async (name: string, value: object) => {
      const out = path.join(dir, name);
      fs.mkdirSync(dir, { recursive: true });
      const specPath = path.join(dir, `${name}.json`);
      fs.writeFileSync(specPath, JSON.stringify(value));
      await CloudflareWorkerAdapter.scaffold(specPath, out);
      await withBuildLock(() => CloudflareWorkerAdapter.build(out));
      return out;
    };
    outDir = await build('with-crons', spec);
    plainDir = await build('plain', SPEC);
  }, 180_000);

  const load = async (dir: string) =>
    (await import(pathToFileURL(path.join(dir, 'dist', 'worker.js')).href)).default as {
      scheduled: (c: { cron: string }, env: Record<string, unknown>, ctx: { waitUntil(p: Promise<unknown>): void }) => Promise<void>;
    };

  it('has crons in wrangler.toml, no node: references, and runs the matching trigger inside waitUntil', async () => {
    expect(fs.readFileSync(path.join(outDir, 'wrangler.toml'), 'utf8')).toContain('crons = ["0 9 * * MON", "*/5 * * * *"]');
    expect(findNodeBuiltinReferences(fs.readFileSync(path.join(outDir, 'dist', 'worker.js'), 'utf8'))).toEqual([]);

    const kv = fakeKV();
    const waited: Promise<unknown>[] = [];
    await (await load(outDir)).scheduled({ cron: '0 9 * * MON' }, { [CHECKPOINT_KV_BINDING]: kv }, { waitUntil: (p) => void waited.push(p) });
    expect(waited).toHaveLength(1);
    await waited[0];
    const keys = [...kv.data.keys()];
    expect(keys.some((key) => key.includes('schedule-report'))).toBe(true);
    expect(keys.some((key) => key.includes('schedule-tick'))).toBe(false);
  });

  it('never throws, and logs, when a turn fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing: KVBinding = { get: async () => Promise.reject(new Error('kv down')), put: async () => Promise.reject(new Error('kv down')), delete: async () => undefined };
    const waited: Promise<unknown>[] = [];
    await (await load(outDir)).scheduled({ cron: '*/5 * * * *' }, { [CHECKPOINT_KV_BINDING]: failing }, { waitUntil: (p) => void waited.push(p) });
    await expect(Promise.all(waited)).resolves.toBeDefined();
    expect(error.mock.calls.some((call) => String(call[0]).includes("'tick'"))).toBe(true);
    error.mockRestore();
  });

  it('a spec without cron triggers has no [triggers] and ignores a scheduled call', async () => {
    expect(fs.readFileSync(path.join(plainDir, 'wrangler.toml'), 'utf8')).not.toContain('[triggers]');
    const waited: Promise<unknown>[] = [];
    await (await load(plainDir)).scheduled({ cron: '* * * * *' }, {}, { waitUntil: (p) => void waited.push(p) });
    expect(waited).toHaveLength(0);
  });

  it('`wrangler deploy --dry-run` accepts the generated [triggers]', () => {
    const wranglerBin = path.join(path.dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
    const output = execFileSync(process.execPath, [wranglerBin, 'deploy', '--dry-run', '--outdir', path.join(outDir, 'dry')], {
      cwd: outDir,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    }).toString();
    expect(output).toContain('--dry-run');
  }, 120_000);
});
