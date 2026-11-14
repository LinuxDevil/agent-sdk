import { defineConfig } from 'vitest/config';

// W15b: the bridge compatibility matrix runs ONLY here - it needs a built
// SDK (default: this checkout; `LOUSHO_BRIDGE_SDK_DIR` points at another,
// e.g. the minimum supported release) and spawns real `lousho bridge`
// children, so it stays out of `test:server` (see vitest.config.ts).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['server/__tests__/bridge.compat.test.ts'],
    testTimeout: 60_000,
    env: {
      LOUSHO_STUDIO_COLLECTOR: '0',
    },
  },
});
