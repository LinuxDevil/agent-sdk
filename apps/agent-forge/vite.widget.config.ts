import { defineConfig } from 'vite';

/**
 * The `<forge-chat>` widget bundle (X04b): one self-contained IIFE that
 * registers the custom element, served by Studio at
 * `GET /serve/:id/widget.js`. `emptyOutDir` only clears `dist/widget`,
 * never the SPA's `dist/` - `build:studio` runs the SPA build first.
 */
export default defineConfig({
  build: {
    outDir: 'dist/widget',
    emptyOutDir: true,
    lib: {
      entry: 'src/widget/entry.ts',
      name: 'ForgeChat',
      formats: ['iife'],
      fileName: () => 'forge-chat.js',
    },
    minify: 'esbuild',
    sourcemap: false,
    target: 'es2020',
  },
});
