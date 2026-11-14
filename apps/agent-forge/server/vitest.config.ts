import { defineConfig } from 'vitest/config';

// Separate from apps/agent-forge/vite.config.ts (which is jsdom-scoped to
// `src/**`, the browser app) - the server is plain Node, and
// supertest/express/ws need real Node globals, not a DOM shim.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['server/**/*.{test,spec}.ts', 'evals/**/*.test.ts'],
    env: {
      // Like the e2e server's observe stub: tests never spawn a real
      // collector daemon - `startStudioServer` probes only (collector.ts).
      LOUSHO_STUDIO_COLLECTOR: '0',
    },
    // W03a: the Studio home defaults to ~/.lousho/studio - point every
    // server test file at its own temp home so no test writes a real one.
    setupFiles: ['server/__tests__/setupStudioHome.ts'],
  },
});
