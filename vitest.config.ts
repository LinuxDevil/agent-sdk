import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Excludes the LOU-E11 fixture repo's own test file - it's a plain
    // node:test suite meant to be run by the fixture's own `npm test`
    // (via createTestRunGuardrail() against a scratch copy of it), not
    // collected by vitest here.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/execution/__fixtures__/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', 'dist/**', 'node_modules/**'],
      // Floor set 1-2 points below the measured baseline (LOU-B4). Measured with
      // `npm run test:coverage`, excluding the 3 provider test suites that fail
      // to even load in this repo because @ai-sdk/openai and ollama-ai-provider
      // are optional peer deps that aren't installed here (see LOU-B2/typings).
      // Baseline: statements 62.81%, branches 84.52%, functions 73.36%, lines 62.81%.
      thresholds: {
        statements: 61,
        branches: 83,
        functions: 72,
        lines: 61,
      },
    },
  },
});
