import { defineConfig } from 'vitest/config';
// Live-model tests cost money and are opt-in only (`npm run test:live`,
// needs e.g. OPENROUTER_API_KEY in the shell or .env). The default
// vitest.config.ts excludes **/*.live.test.ts, so none of this ever runs in CI.
export default defineConfig({
  test: { include: ['src/**/*.live.test.ts', 'examples/**/*.live.test.ts', 'registry/**/*.live.test.ts'], testTimeout: 60_000 },
});
