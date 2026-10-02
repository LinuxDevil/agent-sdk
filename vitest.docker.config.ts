import { defineConfig } from 'vitest/config';

// Standalone config (NOT merged with vitest.config.ts) for the real-daemon
// Docker suite (LOU-M6): `*.docker.test.ts` files start containers, networks
// and images on a Docker Engine. The main vitest.config.ts excludes the same
// pattern, so `npm test` and `npm run test:coverage` never pick them up.
//
// Run via `npm run test:docker`. In CI, `.github/workflows/docker.yml` runs it
// on GitHub's ubuntu-latest runner (rootful Docker Engine) with
// LOUSHO_DOCKER_TESTS=1, which makes the suite fail rather than skip when no
// daemon answers (see src/security/docker.testkit.ts).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.docker.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The files share one daemon (networks, images, the bridge's iptables);
    // run them one at a time.
    fileParallelism: false,
  },
});
