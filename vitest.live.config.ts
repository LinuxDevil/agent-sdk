import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
// Live-model tests cost money and are opt-in only (`npm run test:live`,
// needs e.g. OPENROUTER_API_KEY in the shell or .env). The default
// vitest.config.ts excludes **/*.live.test.ts, so none of this ever runs in CI.
// Vitest only puts .env on import.meta.env, so the file is merged into
// process.env here for the tests' process.env.OPENROUTER_API_KEY checks.
Object.assign(process.env, loadEnv('test', process.cwd(), ''));
export default defineConfig({
  test: { include: ['src/**/*.live.test.ts', 'examples/**/*.live.test.ts', 'registry/**/*.live.test.ts'], testTimeout: 60_000 },
});
