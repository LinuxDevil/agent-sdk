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
  WORKER_SUPPORTED_PROVIDERS,
  WORKER_SUPPORTED_TOOLS,
  findNodeBuiltinReferences,
  formatBundleSize,
  measureBundleSize,
  workerName,
  wranglerTomlSource,
} from './cloudflare';
import { CHECKPOINT_KV_BINDING } from '../checkpointBinding';
import { getAdapter, registerBuiltInAdapters } from '../index';
import { LLMProviderRegistry } from '../../providers/llm';
import { prepareWorkerSpec } from '../runtime.worker';
import { withBuildLock } from '../buildLock.testkit';

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

/**
 * The bundle minus `ai` v6/v7's runtime-guarded `getBuiltinModule("node:...")`
 * probes (LOU-D28c; which ids are allowed is findNodeBuiltinReferences' job).
 * On `ai` v4 there are none, so this is the whole bundle.
 */
function withoutBuiltinProbes(bundle: string): string {
  return bundle.replace(/(?:get|load)(?:Node|Builtin)Module\d*(?:\?\.)?\(\s*"node:[a-z_]+"\s*\)/g, '');
}

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
    expect(workerName({ ...SPEC, name: '***' })).toBe('lousho-agent');
    expect(workerName({ ...SPEC, name: 'x'.repeat(100) })).toHaveLength(63);
  });

  it('findNodeBuiltinReferences detects node: specifiers', () => {
    expect(findNodeBuiltinReferences(`import fs from "node:fs"; require('node:http')`)).toEqual([
      '"node:fs"',
      "'node:http'",
    ]);
    // esbuild drops the prefix of a builtin it leaves external: a bare specifier is a leak too.
    expect(findNodeBuiltinReferences(`import { randomUUID } from "crypto"; const m = await import("fs/promises");`)).toEqual(['"crypto"', '"fs/promises"']);
    expect(findNodeBuiltinReferences('const x = "no builtins here"; import { x } from "./path";')).toEqual([]);
  });

  it('findNodeBuiltinReferences accepts only the allowlisted getBuiltinModule probes of ai v6/v7 (LOU-D28c, LOU-M8)', () => {
    const probes = 'loadBuiltinModule2("node:diagnostics_channel"); loadBuiltinModule4("node:dns"); process.getBuiltinModule?.("node:async_hooks"); loadBuiltinModule("node:module"); await loadNodeModule("node:dns");';
    expect(findNodeBuiltinReferences(probes)).toEqual([]);
    // Any other builtin, or an allowlisted id outside a probe call, is still a leak.
    expect(findNodeBuiltinReferences('loadBuiltinModule("node:fs"); const id = "node:dns"; import("node:async_hooks");')).toEqual([
      '"node:fs"',
      '"node:dns"',
      '"node:async_hooks"',
    ]);
  });

  it('rejects tools and providers that cannot run on Workers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cf-bad-'));
    const out = path.join(dir, 'out');
    await expect(
      CloudflareWorkerAdapter.scaffold(writeSpec(dir, { ...SPEC, tools: ['web-fetch'] }), out)
    ).rejects.toThrow(/tool 'web-fetch' is not available on Cloudflare Workers/);
    // 'ollama' stays unsupported (see runtime.worker.ts doc comment: it
    // defaults to a local endpoint unreachable from a Worker).
    await expect(
      CloudflareWorkerAdapter.scaffold(
        writeSpec(dir, { ...SPEC, provider: { type: 'ollama', model: 'llama3' } }),
        out
      )
    ).rejects.toThrow(/provider 'ollama' is not supported by the cloudflare-worker target/);
    expect(WORKER_SUPPORTED_TOOLS).toEqual(['current-date', 'day-name', 'http']);
    expect(WORKER_SUPPORTED_PROVIDERS).toEqual(['mock', 'openai', 'anthropic', 'openrouter']);
  });

  it('adds a commented LOUSHO_HTTP_ALLOW under [vars] to wrangler.toml only when the spec lists http (M3a)', () => {
    expect(wranglerTomlSource({ ...SPEC, tools: ['http'] })).toContain('# [vars]\n# LOUSHO_HTTP_ALLOW = "api.example.com"\n');
    expect(wranglerTomlSource(SPEC)).not.toContain('LOUSHO_HTTP_ALLOW');
  });

  it("registers 'openrouter' in the Worker's LLMProviderRegistry with the OPENROUTER_API_KEY binding (M3a)", () => {
    expect(LLMProviderRegistry.has('openrouter')).toBe(true);
    const prepared = prepareWorkerSpec(
      { ...SPEC, provider: { type: 'openrouter', model: 'openai/gpt-4o-mini' } },
      { OPENROUTER_API_KEY: 'sk-or-test' }
    );
    expect(prepared.provider.name).toBe('openrouter');
    // The Worker resolves 'http' to its own allowlisted http_request, built from env.
    const withHttp = prepareWorkerSpec({ ...SPEC, tools: ['http'] }, { LOUSHO_HTTP_ALLOW: 'api.example.com' });
    expect(withHttp.toolRegistry?.get('http')?.name).toBe('http_request');
    expect(() => prepareWorkerSpec({ ...SPEC, tools: ['web-fetch'] })).toThrow(/tool 'web-fetch' is not available on Cloudflare Workers/);
  });

  it("registers 'openai' and 'anthropic' in the Worker's LLMProviderRegistry (LOU-K3)", () => {
    // Importing runtime.worker.ts (done at module load via the top-level
    // import above) must have registered both without throwing, and
    // constructing each provider (no network call happens until
    // generate()/stream() is actually invoked) must succeed with an API
    // key sourced the way prepareWorkerSpec reads it - from Worker `env`
    // bindings, never process.env.
    expect(LLMProviderRegistry.has('openai')).toBe(true);
    expect(LLMProviderRegistry.has('anthropic')).toBe(true);

    const openaiPrepared = prepareWorkerSpec(
      { ...SPEC, provider: { type: 'openai', model: 'gpt-4o-mini' } },
      { OPENAI_API_KEY: 'sk-test' }
    );
    expect(openaiPrepared.provider.name).toBe('openai');

    const anthropicPrepared = prepareWorkerSpec(
      { ...SPEC, provider: { type: 'anthropic', model: 'claude-3-5-sonnet-latest' } },
      { ANTHROPIC_API_KEY: 'sk-ant-test' }
    );
    expect(anthropicPrepared.provider.name).toBe('anthropic');
  });

  describe('scaffold + build', () => {
    let outDir: string;

    beforeAll(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cf-'));
      outDir = path.join(dir, 'out');
      await CloudflareWorkerAdapter.scaffold(writeSpec(dir, SPEC), outDir);
      await withBuildLock(() => CloudflareWorkerAdapter.build(outDir));
    }, 120_000);

    it('scaffolds worker.ts (fetch handler, no Node builtins), agent.config.js and wrangler.toml', () => {
      const worker = fs.readFileSync(path.join(outDir, 'worker.ts'), 'utf8');
      expect(worker).toContain('export async function fetch(request: Request');
      expect(worker).toContain('handleWorkerRequest(request, env, spec)');
      expect(findNodeBuiltinReferences(worker)).toEqual([]);
      expect(fs.readFileSync(path.join(outDir, 'agent.config.js'), 'utf8')).toContain('CF Test Agent!');
      expect(fs.readFileSync(path.join(outDir, 'wrangler.toml'), 'utf8')).toContain('main = "dist/worker.js"');
    });

    it('builds an ESM dist/worker.js with zero node: references', () => {
      const bundle = fs.readFileSync(path.join(outDir, 'dist', 'worker.js'), 'utf8');
      expect(bundle.length).toBeGreaterThan(0);
      expect(findNodeBuiltinReferences(bundle)).toEqual([]);
      expect(withoutBuiltinProbes(bundle)).not.toMatch(/node:/);
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
      const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cf-oversized-'));
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

    it("the built bundle serves sessions, SSE and bearer auth like the node server (LOU-D51)", async () => {
      const mod = await import(pathToFileURL(path.join(outDir, 'dist', 'worker.js')).href);
      const handler = mod.default as { fetch: (r: Request, env?: Record<string, unknown>) => Promise<Response> };
      const env = { LOUSHO_API_TOKEN: 'tok' };
      const auth = { Authorization: 'Bearer tok' };
      const post = (body: unknown, headers: Record<string, string> = {}) =>
        handler.fetch(new Request('http://worker/chat', { method: 'POST', headers, body: JSON.stringify(body) }), env);

      expect((await handler.fetch(new Request('http://worker/health'), env)).status).toBe(200);
      expect((await post({ sessionId: 'built-1', input: 'hi' })).status).toBe(401);

      const turn = await post({ sessionId: 'built-1', input: 'hi' }, auth);
      expect(turn.headers.get('content-type')).toContain('text/event-stream');
      const raw = await turn.text();
      expect(raw).toContain('"type":"run.done"');
      expect(raw.endsWith('event: done\ndata: {}\n\n')).toBe(true);

      const transcript = await handler.fetch(new Request('http://worker/chat/built-1', { headers: auth }), env);
      expect((await transcript.json()).messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
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
        // The KV binding the generated wrangler.toml leaves commented out, and the token secret (a .dev.vars file).
        fs.appendFileSync(path.join(outDir, 'wrangler.toml'), `[[kv_namespaces]]\nbinding = "${CHECKPOINT_KV_BINDING}"\nid = "local-dev"\n`);
        fs.writeFileSync(path.join(outDir, '.dev.vars'), 'LOUSHO_API_TOKEN=dev-token\n');
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
            headers: { Authorization: 'Bearer dev-token' },
            body: JSON.stringify({ message: 'hello from workerd' }),
          });
          expect(chat.status).toBe(200);
          expect((await chat.json()).text).toBe('This is a mock response.');

          // LOU-D51: a streamed turn with a session, over the KV namespace wrangler dev simulates.
          const streamed = await fetch(`${base}/chat`, {
            method: 'POST',
            headers: { Authorization: 'Bearer dev-token' },
            body: JSON.stringify({ sessionId: 'workerd-1', input: 'hello from workerd' }),
          });
          expect(streamed.status).toBe(200);
          expect(streamed.headers.get('content-type')).toContain('text/event-stream');
          const raw = await streamed.text();
          expect(raw).toContain('"text":"This is a mock response."');
          expect(raw.endsWith('event: done\ndata: {}\n\n')).toBe(true);

          const transcript = await fetch(`${base}/chat/workerd-1`, { headers: { Authorization: 'Bearer dev-token' } });
          expect((await transcript.json()).messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
          expect((await fetch(`${base}/chat/workerd-1`)).status).toBe(401);
        } finally {
          killTree(child);
        }
      }, 150_000);
    });
  });

  describe('scaffold + build with a real provider (LOU-K3, M3a)', () => {
    const MODELS = { openai: 'gpt-4o-mini', anthropic: 'claude-3-5-sonnet-latest', openrouter: 'openai/gpt-4o-mini' } as const;
    const HOSTS = { openai: 'api.openai.com', anthropic: 'api.anthropic.com', openrouter: 'openrouter.ai' } as const;

    it.each(['openai', 'anthropic', 'openrouter'] as const)(
      "scaffolds and builds a Worker bundle for provider '%s' with zero node: references",
      async (providerType) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lousho-cf-${providerType}-`));
        const outDir = path.join(dir, 'out');

        await CloudflareWorkerAdapter.scaffold(
          writeSpec(dir, { ...SPEC, provider: { type: providerType, model: MODELS[providerType] } }),
          outDir
        );
        await withBuildLock(() => CloudflareWorkerAdapter.build(outDir));

        const bundlePath = path.join(outDir, 'dist', 'worker.js');
        const bundle = fs.readFileSync(bundlePath, 'utf8');
        expect(bundle.length).toBeGreaterThan(0);
        expect(findNodeBuiltinReferences(bundle)).toEqual([]);
        expect(withoutBuiltinProbes(bundle)).not.toMatch(/node:/);

        // Drive the real built bundle's fetch() handler end to end, with the
        // network replaced by a fetch that answers 401 (no request leaves the
        // machine). The provider must have been resolved and must have called
        // its own API: a registry/"not supported" error would mean the wiring
        // is broken, which is what LOU-K3 and M3a fix.
        const requested: string[] = [];
        const original = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          requested.push(input instanceof Request ? input.url : String(input));
          return new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        try {
          const mod = await import(pathToFileURL(bundlePath).href);
          const handler = mod.default as { fetch: (r: Request, env?: Record<string, unknown>) => Promise<Response> };
          const chat = await handler.fetch(
            new Request('http://worker/chat', { method: 'POST', body: JSON.stringify({ message: 'hi' }) }),
            { [`${providerType.toUpperCase()}_API_KEY`]: 'sk-test-not-a-real-key' }
          );
          const body = await chat.json();
          expect(chat.status).toBe(500);
          expect(String(body.error)).not.toMatch(/not found\. Available:|not supported by the cloudflare-worker target/);
        } finally {
          globalThis.fetch = original;
        }
        expect(requested.length).toBeGreaterThan(0);
        expect(requested.every((url) => new URL(url).hostname === HOSTS[providerType])).toBe(true);
      },
      60_000
    );
  });

  describe("scaffold + build with the 'http' tool (M3a)", () => {
    let outDir: string;

    beforeAll(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cf-http-'));
      outDir = path.join(dir, 'out');
      await CloudflareWorkerAdapter.scaffold(
        writeSpec(dir, { ...SPEC, provider: { type: 'openrouter', model: 'openai/gpt-4o-mini' }, tools: ['http'] }),
        outDir
      );
      await withBuildLock(() => CloudflareWorkerAdapter.build(outDir));
    }, 120_000);

    it('builds with zero node: references and a commented LOUSHO_HTTP_ALLOW in wrangler.toml', () => {
      const bundle = fs.readFileSync(path.join(outDir, 'dist', 'worker.js'), 'utf8');
      expect(findNodeBuiltinReferences(bundle)).toEqual([]);
      expect(withoutBuiltinProbes(bundle)).not.toMatch(/node:/);
      expect(fs.readFileSync(path.join(outDir, 'wrangler.toml'), 'utf8')).toContain('# LOUSHO_HTTP_ALLOW = "api.example.com"');
    });

    /** OpenRouter's chat completions answer: `message` as the one choice. */
    function completion(message: Record<string, unknown>, finishReason: string): Response {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model: 'openai/gpt-4o-mini',
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    /**
     * Stands in for the network: OpenRouter's chat completions endpoint
     * scripts a model that calls the spec's `http` tool (createAgent names a spec tool after its key) on `https://api.example.com/data`
     * and then answers with the tool's result; api.example.com answers 'the
     * listed body'. Returns the URLs requested.
     */
    function scriptedNetwork(): string[] {
      const requested: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        requested.push(url);
        if (new URL(url).hostname === 'api.example.com') return new Response('the listed body', { status: 200 });
        const request = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}')));
        const toolMessage = [...request.messages].reverse().find((message: { role: string }) => message.role === 'tool');
        if (toolMessage) return completion({ role: 'assistant', content: `tool said: ${toolMessage.content}` }, 'stop');
        const args = JSON.stringify({ url: 'https://api.example.com/data', method: 'GET' });
        return completion(
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'http', arguments: args } }] },
          'tool_calls'
        );
      }) as typeof fetch;
      return requested;
    }

    async function chat(env: Record<string, unknown>): Promise<{ text: string; requested: string[] }> {
      const original = globalThis.fetch;
      const requested = scriptedNetwork();
      try {
        const mod = await import(pathToFileURL(path.join(outDir, 'dist', 'worker.js')).href);
        const handler = mod.default as { fetch: (r: Request, env?: Record<string, unknown>) => Promise<Response> };
        const response = await handler.fetch(
          new Request('http://worker/chat', { method: 'POST', body: JSON.stringify({ message: 'fetch the data' }) }),
          { OPENROUTER_API_KEY: 'sk-or-test-not-a-real-key', ...env }
        );
        const body = await response.json();
        expect([response.status, body.error]).toEqual([200, undefined]);
        return { text: String(body.text), requested };
      } finally {
        globalThis.fetch = original;
      }
    }

    it('refuses the request when LOUSHO_HTTP_ALLOW is unset (fail closed)', async () => {
      const { text, requested } = await chat({});
      expect(text).toContain('no hosts are allowed; list them in the LOUSHO_HTTP_ALLOW binding');
      expect(text).not.toContain('the listed body');
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.every((url) => new URL(url).hostname === 'openrouter.ai')).toBe(true);
    });

    it('refuses a host the binding does not list', async () => {
      const { text, requested } = await chat({ LOUSHO_HTTP_ALLOW: 'api.github.com' });
      expect(text).toContain('host api.example.com is not in the allowlist (LOUSHO_HTTP_ALLOW)');
      expect(requested.some((url) => url.includes('api.example.com'))).toBe(false);
    });

    it('returns the body when the binding lists the host', async () => {
      const { text, requested } = await chat({ LOUSHO_HTTP_ALLOW: 'api.github.com, *.example.com' });
      // The OpenAI package of `ai` 4 sends a string tool result JSON-quoted; those of `ai` 6/7 send it as is (LOU-M8).
      expect(text).toMatch(/^tool said: "?the listed body"?$/);
      expect(requested).toContain('https://api.example.com/data');
    });
  });
});
