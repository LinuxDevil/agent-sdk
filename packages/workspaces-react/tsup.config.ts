import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  tsconfig: 'tsconfig.build.json',
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  platform: 'browser',
  external: ['react', 'react-dom', 'react/jsx-runtime', '@linuxdevil/lousho', '@linuxdevil/lousho/workspaces/client'],
});
