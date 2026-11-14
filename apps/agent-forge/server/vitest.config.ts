import { defineConfig } from 'vitest/config';

// Separate from apps/agent-forge/vite.config.ts (which is jsdom-scoped to
// `src/**`, the browser app) - the server is plain Node, and
// supertest/express/ws need real Node globals, not a DOM shim.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['server/**/*.{test,spec}.ts', 'evals/**/*.test.ts'],
    // bridge.compat.test.ts runs only under server/vitest.compat.config.ts
    // (it needs a built SDK and LOUSHO_BRIDGE_SDK_DIR plumbing).
    exclude: ['server/__tests__/bridge.compat.test.ts'],
    env: {
      // Like the e2e server's observe stub: tests never spawn a real
      // collector daemon - `startStudioServer` probes only (collector.ts).
      LOUSHO_STUDIO_COLLECTOR: '0',
    },
  },
});
