import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Adds '**/*.eval.ts' (LOU-G2) alongside vitest's own default
    // '**/*.{test,spec}.?(c|m)[jt]s?(x)' pattern (there was no explicit
    // `include` before this, so the default test/spec pattern is spelled
    // out here too) so eval files defined via defineEval() run as part of
    // the normal `vitest run` / `npm test` path.
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)', '**/*.eval.ts'],
    // Excludes the LOU-E11 fixture repo's own test file - it's a plain
    // node:test suite meant to be run by the fixture's own `npm test`
    // (via createTestRunGuardrail() against a scratch copy of it), not
    // collected by vitest here.
    //
    // Also excludes '**/*.judge.eval.ts' (LOU-G6): llmJudge()-based evals
    // call out to a real LLM provider and must NEVER run in the default
    // `vitest run` path. Without this exclude, '**/*.eval.ts' above would
    // also match 'foo.judge.eval.ts' (it still ends in '.eval.ts'), so the
    // exclude is required, not just the more specific include pattern.
    // Judge evals are run exclusively via vitest.judge.config.ts /
    // `npm run test:evals:judge`.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'src/execution/__fixtures__/**',
      '**/*.judge.eval.ts',
    ],
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
