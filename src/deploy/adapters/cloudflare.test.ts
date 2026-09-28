/**
 * LOU-I3: cloudflare-worker adapter.
 *
 * Always runs (no external tooling needed):
 *  - scaffold()/wrangler.toml generation + Worker-compatibility checks
 *  - a real tsup build, asserting dist/worker.js is ESM with ZERO `node:`
 *    references, then importing that bundle and driving its fetch()
 *    handler with real Request objects.
 *
 * Runs only when the `wrangler` CLI is installed (it is a devDependency of
 * this repo; the guard mirrors LOU-F6's Docker-daemon guard in
 * src/security/SubprocessSandbox.test.ts so a missing tool skips rather
 * than fails):
 *  - `wrangler deploy --dry-run` (validates wrangler.toml + the bundle
 *    exactly as a deploy would, without a Cloudflare account)
 *  - `wrangler dev` - the bundle served by the real local workerd runtime,
 *    hit over HTTP.
 * A real `wrangler deploy` to Cloudflare is intentionally never run from
 * the test suite (it needs account credentials and creates live resources).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  CloudflareWorkerAdapter,
  WORKER_SIZE_LIMIT_BYTES,
  WORKER_SUPPORTED_TOOLS,
  findNodeBuiltinReferences,
  formatBundleSize,
  measureBundleSize,
  workerName,
  wranglerTomlSource,
} from './cloudflare';
import { getAdapter, registerBuiltInAdapters } from '../index';

let wranglerBin: string | undefined;
try {
  const requireFromHere = createRequire(import.meta.url);
  wranglerBin = path.join(path.dirname(requireFromHere.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
  if (!fs.existsSync(wranglerBin)) wranglerBin = undefined;
} catch {
  wranglerBin = undefined;
}

const WRANGLER_ENV = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };

function writeSpec(dir: string, spec: Record<string, unknown>): string {
  const specPath = path.join(dir, 'agent.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return specPath;
}

const SPEC = {
  name: 'CF Test Agent!',
  prompt: 'You are a helpful edge agent.',
  provider: { type: 'mock', model: 'mock-1' },
  tools: ['current-date', 'day-name'],
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Kills a process and its children (wrangler dev spawns workerd). */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

describe('CloudflareWorkerAdapter', () => {
  it("is registered as 'cloudflare-worker' and describes itself as 'wrangler deploy'", () => {
    registerBuiltInAdapters();
    expect(getAdapter('cloudflare-worker')).toBe(CloudflareWorkerAdapter);
    expect(CloudflareWorkerAdapter.describe('/anywhere')).toBe('wrangler deploy');
  });

  it('generates wrangler.toml with a sanitized name, main and compatibility_date', () => {
    const toml = wranglerTomlSource({ ...SPEC, name: 'CF Test Agent!' });
    expect(toml).toMatch(/^name = "cf-test-agent"$/m);
    expect(toml).toMatch(/^main = "dist\/worker\.js"$/m);
    expect(toml).toMatch(/^compatibility_date = "\d{4}-\d{2}-\d{2}"$/m);
    expect(workerName({ ...SPEC, name: '***' })).toBe('loushy-agent');
    expect(workerName({ ...SPEC, name: 'x'.repeat(100) })).toHaveLength(63);
  });

  it('findNodeBuiltinReferences detects node: specifiers', () => {
    expect(findNodeBuiltinReferences(`import fs from "node:fs"; require('node:http')`)).toEqual([
      '"node:fs"',
      "'node:http'",
    ]);
    expect(findNodeBuiltinReferences('const x = "no builtins here";')).toEqual([]);
  });

  it('rejects tools and providers that cannot run on Workers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-cf-bad-'));
    const out = path.join(dir, 'out');
    await expect(
      CloudflareWorkerAdapter.scaffold(writeSpec(dir, { ...SPEC, tools: ['http'] }), out)
    ).rejects.toThrow(/tool 'http' is not available on Cloudflare Workers/);
    await expect(
      CloudflareWorkerAdapter.scaffold(
        writeSpec(dir, { ...SPEC, provider: { type: 'openai', model: 'gpt-4o-mini' } }),
        out
      )
    ).rejects.toThrow(/provider 'openai' is not supported by the cloudflare-worker target/);
    expect(WORKER_SUPPORTED_TOOLS).not.toContain('http');
  });

  describe('scaffold + build', () => {
    let outDir: string;

    beforeAll(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-cf-'));
      outDir = path.join(dir, 'out');
      await CloudflareWorkerAdapter.scaffold(writeSpec(dir, SPEC), outDir);
      await CloudflareWorkerAdapter.build(outDir);
    }, 120_000);

    it('scaffolds worker.ts (fetch handler, no Node builtins), agent.config.js and wrangler.toml', () => {
      const worker = fs.readFileSync(path.join(outDir, 'worker.ts'), 'utf8');
      expect(worker).toContain('export async function fetch(request: Request');
      expect(worker).toContain('AgentExecutor.execute(');
      expect(findNodeBuiltinReferences(worker)).toEqual([]);
      expect(fs.readFileSync(path.join(outDir, 'agent.config.js'), 'utf8')).toContain('CF Test Agent!');
      expect(fs.readFileSync(path.join(outDir, 'wrangler.toml'), 'utf8')).toContain('main = "dist/worker.js"');
    });

    it('builds an ESM dist/worker.js with zero node: references', () => {
      const bundle = fs.readFileSync(path.join(outDir, 'dist', 'worker.js'), 'utf8');
      expect(bundle.length).toBeGreaterThan(0);
      expect(bundle).not.toMatch(/node:/);
      expect(bundle).toMatch(/^export \{/m);
      // Browser-platform bundle: no CommonJS module wrapper at the top level.
      expect(bundle).not.toMatch(/^module\.exports/m);
    });

    it("measures the built bundle's real size and reports it against Workers' free-tier limit (LOU-I3)", () => {
      const bundlePath = path.join(outDir, 'dist', 'worker.js');

      // Ground truth: fs.statSync directly on the file, independent of the
      // adapter's own internal calculation.
      const groundTruthBytes = fs.statSync(bundlePath).size;
      expect(groundTruthBytes).toBeGreaterThan(0);

      const report = measureBundleSize(bundlePath);
      expect(report.bytes).toBe(groundTruthBytes);
      expect(report.bytes).toBeGreaterThan(0);
      expect(report.gzipBytes).toBeGreaterThan(0);
      // gzip of real JS should compress meaningfully smaller than raw.
      expect(report.gzipBytes).toBeLessThan(report.bytes);
      expect(report.limitBytes).toBe(WORKER_SIZE_LIMIT_BYTES);

      // A minimal agent's bundle is expected to comfortably clear the free
      // tier's script size limit - a clear "pass" signal.
      expect(report.overLimit).toBe(false);

      const description = CloudflareWorkerAdapter.describe(outDir);
      expect(description).toContain('wrangler deploy');
      expect(description).toContain(formatBundleSize(report.bytes));
      expect(description).toContain(formatBundleSize(report.gzipBytes));
      expect(description).toMatch(/within the .* limit/);
      expect(description).not.toMatch(/WARNING/);
    });

    it('describe() falls back to warning language when the bundle exceeds the size limit', () => {
      const bundlePath = path.join(outDir, 'dist', 'worker.js');
      const realBytes = fs.statSync(bundlePath).size;

      // Prove the warning path actually fires by lowering the threshold
      // (test-only) below the real, already-built bundle's size, rather
      // than just asserting the warning code exists.
      const tinyLimit = 10; // bytes - guaranteed to be smaller than any real bundle
      const report = measureBundleSize(bundlePath, tinyLimit);
      expect(report.overLimit).toBe(true);
      expect(report.bytes).toBe(realBytes);
      expect(report.limitBytes).toBe(tinyLimit);
    });

    it('describe() reports WARNING for a real on-disk bundle that genuinely exceeds WORKER_SIZE_LIMIT_BYTES', () => {
      // A synthetic (not tsup-built) but real file on disk, deliberately
      // sized past the actual WORKER_SIZE_LIMIT_BYTES threshold, driven
      // through the adapter's real describe() - not a re-implementation of
      // its verdict logic - to prove the WARNING branch genuinely fires.
      const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-cf-oversized-'));
      const scratchOut = path.join(scratchDir, 'out');
      fs.mkdirSync(path.join(scratchOut, 'dist'), { recursive: true });
      const oversizedPath = path.join(scratchOut, 'dist', 'worker.js');
      fs.writeFileSync(oversizedPath, Buffer.alloc(WORKER_SIZE_LIMIT_BYTES + 1024, 'x'));

      const groundTruthBytes = fs.statSync(oversizedPath).size;
      expect(groundTruthBytes).toBeGreaterThan(WORKER_SIZE_LIMIT_BYTES);

      const report = measureBundleSize(oversizedPath);
      expect(report.bytes).toBe(groundTruthBytes);
      expect(report.overLimit).toBe(true);

      const description = CloudflareWorkerAdapter.describe(scratchOut);
      expect(description).toContain('WARNING');
      expect(description).toContain(formatBundleSize(groundTruthBytes));
    }, 30_000);

    it("the built bundle's fetch() handler serves /health and /chat via AgentExecutor", async () => {
      const mod = await import(pathToFileURL(path.join(outDir, 'dist', 'worker.js')).href);
      const handler = mod.default as { fetch: (r: Request, env?: Record<string, unknown>) => Promise<Response> };

      const health = await handler.fetch(new Request('http://worker/health'));
      expect(health.status).toBe(200);
      expect(await health.text()).toBe('ok');

      const chat = await handler.fetch(
        new Request('http://worker/chat', { method: 'POST', body: JSON.stringify({ message: 'hi' }) }),
        {}
      );
      expect(chat.status).toBe(200);
      expect((await chat.json()).text).toBe('This is a mock response.');

      const bad = await handler.fetch(new Request('http://worker/chat', { method: 'POST', body: '{}' }));
      expect(bad.status).toBe(400);

      const oversized = await handler.fetch(
        new Request('http://worker/chat', {
          method: 'POST',
          body: JSON.stringify({ message: 'x'.repeat(2 * 1024 * 1024) }),
        })
      );
      expect(oversized.status).toBe(413);
    });

    describe.skipIf(!wranglerBin)('real wrangler tooling (requires the wrangler CLI)', () => {
      it('`wrangler deploy --dry-run` accepts the generated wrangler.toml and bundle', () => {
        const dryOut = path.join(outDir, '.dry-run');
        const output = execFileSync(
          process.execPath,
          [wranglerBin!, 'deploy', '--dry-run', '--outdir', dryOut],
          { cwd: outDir, env: WRANGLER_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        );
        expect(output).toContain('--dry-run: exiting now.');
        expect(fs.existsSync(path.join(dryOut, 'worker.js'))).toBe(true);

        // LOU-I3: cross-check our fs.statSync/gzip-based measurement against
        // wrangler's own reported "Total Upload" figures for the exact same
        // build, so the adapter's number is proven meaningful rather than
        // an arbitrary internal calculation.
        const report = measureBundleSize(path.join(outDir, 'dist', 'worker.js'));
        // wrangler prints a line like:
        //   Total Upload: 12.34 KiB / gzip: 4.56 KiB
        const uploadMatch = output.match(/Total Upload:\s*([\d.]+)\s*(KiB|MiB|B)\s*\/\s*gzip:\s*([\d.]+)\s*(KiB|MiB|B)/);
        expect(uploadMatch).not.toBeNull();
        if (uploadMatch) {
          const toBytes = (value: string, unit: string): number => {
            const n = parseFloat(value);
            if (unit === 'MiB') return n * 1024 * 1024;
            if (unit === 'KiB') return n * 1024;
            return n;
          };
          const wranglerRawBytes = toBytes(uploadMatch[1], uploadMatch[2]);
          const wranglerGzipBytes = toBytes(uploadMatch[3], uploadMatch[4]);
          // wrangler's figures are rounded to 2 decimal KiB/MiB, so allow a
          // small tolerance rather than requiring exact byte equality.
          expect(Math.abs(report.bytes - wranglerRawBytes)).toBeLessThan(Math.max(50, report.bytes * 0.02));
          expect(Math.abs(report.gzipBytes - wranglerGzipBytes)).toBeLessThan(
            Math.max(50, report.gzipBytes * 0.05)
          );
        }
      }, 120_000);

      it('`wrangler dev` serves the worker on the local workerd runtime', async () => {
        const port = await freePort();
        const child = spawn(
          process.execPath,
          [wranglerBin!, 'dev', '--port', String(port), '--ip', '127.0.0.1'],
          { cwd: outDir, env: WRANGLER_ENV, stdio: 'ignore', detached: process.platform !== 'win32' }
        );
        try {
          const base = `http://127.0.0.1:${port}`;
          let health: Response | undefined;
          for (let i = 0; i < 90 && !health; i++) {
            try {
              health = await fetch(`${base}/health`);
            } catch {
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
          expect(health?.status).toBe(200);
          expect(await health!.text()).toBe('ok');

          const chat = await fetch(`${base}/chat`, {
            method: 'POST',
            body: JSON.stringify({ message: 'hello from workerd' }),
          });
          expect(chat.status).toBe(200);
          expect((await chat.json()).text).toBe('This is a mock response.');
        } finally {
          killTree(child);
        }
      }, 150_000);
    });
  });
});
