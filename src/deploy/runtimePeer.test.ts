/**
 * A project scaffolded by create-lousho-agent does not install
 * `@opentelemetry/api` (an optional peer of the SDK; `ai` keeps its own copy
 * nested under node_modules/ai), so the node-server build must neither fail
 * to resolve it nor need it to start: the OTel exporter is loaded only when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set. This repo has it installed, so a
 * plugin hides it from the SDK's own source, as in such a project.
 */
import { describe, expect, it, vi } from 'vitest';
import { build, type Plugin } from 'esbuild';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { bundleExternals, runtimePeerPlugin } from './bundle';
import type { otelTracingFromEnv } from './otelTracing';

/** Fails to resolve `@opentelemetry/api` for importers outside node_modules (the SDK source), like a scaffold whose node_modules lacks it. */
const hideOtelApi: Plugin = {
  name: 'hide-otel-api',
  setup(b) {
    b.onResolve({ filter: /^@opentelemetry\/api(?:\/.*)?$/ }, (args) =>
      /[\\/]node_modules[\\/]/.test(args.importer) ? undefined : { errors: [{ text: `Could not resolve "${args.path}"` }] }
    );
  },
};

describe('runtimePeerPlugin (node-server build without @opentelemetry/api)', () => {
  it('builds the OTel wiring, loads without the package and reports it as missing only when traces are asked for', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-runtime-peer-'));
    try {
      const outfile = path.join(dir, 'server.cjs');
      await build({
        stdin: { contents: `export { otelTracingFromEnv } from ${JSON.stringify(path.join(__dirname, 'otelTracing.ts'))};\n`, resolveDir: __dirname, loader: 'ts' },
        bundle: true,
        outfile,
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        logLevel: 'silent',
        external: bundleExternals().external,
        // Registered first, as in the node-server build: it sees the import before the hiding plugin fails it.
        plugins: [runtimePeerPlugin(), hideOtelApi],
      });

      // dist/server.js runs from a directory where @opentelemetry/api is not installed.
      const mod = createRequire(outfile)(outfile) as { otelTracingFromEnv: typeof otelTracingFromEnv };
      const log = { log: vi.fn(), error: vi.fn() };
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
      vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', '');
      expect(await mod.otelTracingFromEnv({ serviceName: 's', log })).toBeUndefined();
      expect(log.error).not.toHaveBeenCalled();

      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
      expect(await mod.otelTracingFromEnv({ serviceName: 's', log, load: () => Promise.reject(new Error('the OTel SDK must not be loaded first')) })).toBeUndefined();
      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.error.mock.calls[0]![0]).toContain('npm install @opentelemetry/api ');
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('bundles @opentelemetry/api as before when the build can resolve it', async () => {
    const result = await build({
      stdin: { contents: "export { trace } from '@opentelemetry/api';\n", resolveDir: __dirname, loader: 'ts' },
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
      plugins: [runtimePeerPlugin()],
    });
    const code = result.outputFiles[0]!.text;
    expect(code).not.toContain('require("@opentelemetry/api")');
    expect(code).toContain('TraceAPI');
  });
});
