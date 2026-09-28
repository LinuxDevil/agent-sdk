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
    'data/mocks': 'src/data/mocks.ts',
    'cli/dev': 'src/cli/dev.ts',
    'cli/build': 'src/cli/build.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  external: ['ai', 'zod'],
  onSuccess: async () => {
    copyDevUi();
  },
});
