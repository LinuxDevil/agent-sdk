/**
 * #289: `@lousho/build-ai-agent/worker` must bundle for a hand-written
 * Cloudflare Worker, which has no shim for Node builtins (unlike the
 * generated Worker, whose `lousho build` applies them itself). The SDK
 * ships the entry pre-shimmed: tsup.config.ts builds src/deploy/worker.ts
 * through workerEntryPlugins(), and this test applies the same plugins and
 * fails if a `node:` specifier or an unresolvable import remains in the
 * graph - exactly what esbuild reports for the package root today.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { build, stop } from 'esbuild';
import { join } from 'node:path';
import { findNodeBuiltinReferences } from './adapters/cloudflare';
import { WORKER_ENTRY_EXTERNALS, workerEntryPlugins } from './bundle';
import * as worker from './worker';
import * as workerSdk from './workerSdk';

// esbuild keeps a service process alive after build(); end it so it does not outlive this file.
afterAll(() => stop());

describe('@lousho/build-ai-agent/worker (#289)', () => {
  it('bundles for the browser platform with no node: import in its graph or output', async () => {
    const result = await build({
      entryPoints: [join(__dirname, 'worker.ts')],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      // The same specifiers the real build (tsup.config.ts) leaves external.
      external: [...WORKER_ENTRY_EXTERNALS],
      plugins: workerEntryPlugins(),
      metafile: true,
      logLevel: 'silent',
    });

    expect(result.errors).toEqual([]);
    const nodeImports = Object.entries(result.metafile.inputs).flatMap(([file, input]) =>
      input.imports.filter((entry) => entry.path.startsWith('node:')).map((entry) => `${file} -> ${entry.path}`)
    );
    expect(nodeImports).toEqual([]);
    // The output a user's bundler sees must reference no Node builtin,
    // external or inlined (the generated Worker's leak check uses the same scan).
    expect(findNodeBuiltinReferences(result.outputFiles[0].text)).toEqual([]);
    expect(Object.keys(result.metafile.inputs).some((file) => file.endsWith('createAgent.ts'))).toBe(true);
    // OllamaProvider's lazy import() must not survive as a specifier the
    // user's build would fail to resolve (the optional package is usually
    // not installed): it is redirected to a shim that fails on use. The
    // package name itself may remain as a string (loadOptionalPeer's
    // error messages) - only specifiers and bundled files are a leak.
    expect(Object.keys(result.metafile.inputs).filter((file) => file.includes('ollama-ai-provider'))).toEqual([]);
    expect(result.outputFiles[0].text).not.toMatch(/(?:from|import\(|require\()\s*["'`]ollama-ai-provider/);
    expect(Object.keys(result.metafile.inputs).some((file) => file.endsWith('ollama.worker.ts'))).toBe(true);
    // The same goes for the optional @modelcontextprotocol/sdk peer that
    // createAgent({ mcpServers }) lazy-imports: bundled it would add ~700 KB
    // to every Worker, external it would fail the user's build when the peer
    // is not installed - so it resolves to a shim that fails on connect.
    expect(Object.keys(result.metafile.inputs).filter((file) => file.includes('@modelcontextprotocol'))).toEqual([]);
    expect(result.outputFiles[0].text).not.toMatch(/(?:from|import\(|require\()\s*["'`]@modelcontextprotocol\/sdk/);
    expect(Object.keys(result.metafile.inputs).some((file) => file.endsWith('mcp.worker.ts'))).toBe(true);
  }, 30_000);

  it('exports createAgent, the stores, the schedule helpers and the whole Worker-safe subset', () => {
    for (const name of ['createAgent', 'memoryStore', 'KVStore', 'KVCheckpointStore', 'CHECKPOINT_KV_BINDING', 'defineSchedule', 'handleScheduled', 'serveFetch']) {
      expect(worker, name).toHaveProperty(name);
    }
    expect(typeof worker.createAgent).toBe('function');
    // Everything `lousho build` lets agent-directory code import on a Worker
    // is also importable from the subpath (workerSdk.ts is re-exported whole).
    for (const name of Object.keys(workerSdk)) {
      expect(worker, name).toHaveProperty(name);
    }
  });
});
