import { defineConfig } from 'tsup';
import { WORKER_ENTRY_EXTERNALS, workerEntryPlugins } from './src/deploy/bundle';

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * tsup only bundles TS/JS entrypoints - src/cli/dev-ui/index.html (LOU-H7)
 * is a plain static asset dev.ts reads at runtime relative to its own
 * __dirname, so it has to be copied into dist/cli/dev-ui alongside the
 * compiled dev.js by hand.
 */
function copyDevUi() {
  const src = path.join(__dirname, 'src', 'cli', 'dev-ui');
  const dest = path.join(__dirname, 'dist', 'cli', 'dev-ui');
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
}

const entry = {
    index: 'src/index.ts',
    'executor/index': 'src/executor/index.ts',
    'tools/index': 'src/tools/index.ts',
    'tools/mcp/index': 'src/tools/mcp/index.ts',
    'flows/index': 'src/flows/index.ts',
    'integrations/index': 'src/integrations/index.ts',
    'utils/index': 'src/utils/index.ts',
    'types/index': 'src/types/index.ts',
    'testing/index': 'src/testing/index.ts',
    'cli/dev': 'src/cli/dev.ts',
    'cli/chat': 'src/cli/chat.ts',
    'cli/acp': 'src/cli/acp.ts',
    'cli/add': 'src/cli/add.ts',
    'cli/build': 'src/cli/build.ts',
    'cli/studio': 'src/cli/studio.ts',
    'cli/mcp': 'src/cli/mcp.ts',
    'cli/doctor': 'src/cli/doctor.ts',
    'cli/eval': 'src/cli/eval.ts',
    'cli/init': 'src/cli/init.ts',
    'cli/traces': 'src/cli/traces.ts',
    'execution/otel': 'src/execution/otel.ts',
    'execution/hooks': 'src/execution/hooks.ts',
    'storage/sqlite/index': 'src/storage/sqlite/index.ts',
    'auth/index': 'src/auth/index.ts',
    'deploy/kv': 'src/deploy/kv.ts',
    'traces/index': 'src/traces/index.ts',
    'triggers/index': 'src/triggers/index.ts',
    'react/index': 'src/react/index.ts',
    'vue/index': 'src/vue/index.ts',
    'svelte/index': 'src/svelte/index.ts',
};

/**
 * tsup checks `noExternal` before `external`, so the /worker entry's
 * "bundle everything" matcher must carve out the specifiers that stay
 * external (the same pattern bundleExternals() uses for `lousho build`).
 */
const workerNoExternal = new RegExp(
  `^(?!(?:${WORKER_ENTRY_EXTERNALS.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?:/|$))`
);

export default defineConfig([
  {
    entry,
    format: ['cjs', 'esm'],
    // The /worker entry's declarations are emitted here too: its JS build
    // below cannot run dts itself, because every config with clean:true
    // deletes all of dist's *.d.* at the start of its own (parallel) dts
    // run - the two dts builds would race. The dts pass needs no shims:
    // type-only imports emit no code.
    dts: { entry: { ...entry, 'deploy/worker': 'src/deploy/worker.ts' } },
    splitting: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: false,
    // Optional peers (LOU-D40) stay external too: tsup would externalize them from package.json anyway.
    external: ['ai', 'zod', '@opentelemetry/api', 'dockerode', '@modelcontextprotocol/sdk', 'prompts', 'quickjs-emscripten'],
    esbuildOptions(options) {
      // Ship maps without `sourcesContent` (#191): `src/` is in the published
      // package and the maps' `sources` resolve to it, so embedding the source a
      // second time only adds ~5 MB to the tarball.
      options.sourcesContent = false;
    },
    onSuccess: async () => {
      copyDevUi();
    },
  },
  {
    /**
     * The Worker-safe `@lousho/build-ai-agent/worker` entry (#289), built
     * with the same shims `lousho build --target=cloudflare-worker` applies,
     * so the published file has no `node:` import for a hand-written
     * Worker's bundler to fail on. A separate config because the plugins
     * must NOT touch the Node entries above (they need the real builtins).
     * platform 'browser' doubles as the leak check: a `node:` specifier the
     * shims do not redirect fails this build instead of the user's.
     */
    entry: { 'deploy/worker': 'src/deploy/worker.ts' },
    format: ['cjs', 'esm'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    minify: false,
    noExternal: [workerNoExternal],
    external: WORKER_ENTRY_EXTERNALS,
    // Keep `node:` prefixes so the shim plugins can match them (tsup would
    // otherwise externalize them first, like the adapter's own build).
    removeNodeProtocol: false,
    esbuildPlugins: workerEntryPlugins(),
    esbuildOptions(options) {
      // Same as the Node entries above: maps without `sourcesContent` (#191).
      options.sourcesContent = false;
    },
  },
]);
