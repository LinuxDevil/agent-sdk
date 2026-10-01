import { defineConfig } from 'tsup';
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

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'tools/index': 'src/tools/index.ts',
    'tools/mcp/index': 'src/tools/mcp/index.ts',
    'flows/index': 'src/flows/index.ts',
    'data/index': 'src/data/index.ts',
    'types/index': 'src/types/index.ts',
    'testing/index': 'src/testing/index.ts',
    'cli/dev': 'src/cli/dev.ts',
    'cli/chat': 'src/cli/chat.ts',
    'cli/acp': 'src/cli/acp.ts',
    'cli/build': 'src/cli/build.ts',
    'cli/studio': 'src/cli/studio.ts',
    'cli/mcp': 'src/cli/mcp.ts',
    'cli/doctor': 'src/cli/doctor.ts',
    'cli/eval': 'src/cli/eval.ts',
    'cli/init': 'src/cli/init.ts',
    'execution/otel': 'src/execution/otel.ts',
    'execution/hooks': 'src/execution/hooks.ts',
    'storage/sqlite/index': 'src/storage/sqlite/index.ts',
    'triggers/index': 'src/triggers/index.ts',
    'react/index': 'src/react/index.ts',
    'vue/index': 'src/vue/index.ts',
    'svelte/index': 'src/svelte/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  // Optional peers (LOU-D40) stay external too: tsup would externalize them from package.json anyway.
  external: ['ai', 'zod', '@opentelemetry/api', 'dockerode', '@modelcontextprotocol/sdk', 'prompts'],
  onSuccess: async () => {
    copyDevUi();
  },
});
