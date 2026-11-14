import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^lousho\/workspaces\/client$/, replacement: root('../../src/workspaces/client/index.ts') },
      { find: /^lousho\/workspaces$/, replacement: root('../../src/workspaces/index.ts') },
    ],
  },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost' } },
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
