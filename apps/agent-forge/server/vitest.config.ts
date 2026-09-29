import { defineConfig } from 'vitest/config';

// Separate from apps/agent-forge/vite.config.ts (which is jsdom-scoped to
// `src/**`, the browser app) - the LOU-N server is plain Node, and
// supertest/express/ws need real Node globals, not a DOM shim.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['server/**/*.{test,spec}.ts'],
  },
});
