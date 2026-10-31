import { defineConfig } from 'tsup';

// Matches the root project's tsup.config.ts style: named entries, dual
// cjs/esm output, declarations, no bundling of node builtins/deps we don't
// own.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  platform: 'node',
  external: ['prompts'],
});
