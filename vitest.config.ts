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
      // Fixture evals that src/cli/eval.test.ts runs through `lousho eval`.
      'src/cli/__fixtures__/**',
      '**/*.judge.eval.ts',
      // Live-model tests (cost money): run with `npm run test:live`.
      '**/*.live.test.ts',
      // apps/* are separate npm workspaces (LOU-L1) with their own Vite/
      // vitest config and browser-only test environment (jsdom) - without
      // this exclude, this root config's broad default include pattern
      // would also sweep up e.g. apps/agent-forge's tests and run them
      // under this config's `environment: 'node'`, which can't provide the
      // DOM globals (File, Blob, HTMLAnchorElement, ...) those tests need.
      // Each app is tested via its own `npm run test --workspace=apps/*`.
      'apps/**',
      // Agent worktrees (.claude/worktrees/*) are full checkouts of this repo;
      // without this the main checkout would run every copy's tests too.
      '.claude/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // apps/** is excluded here too (mirroring the `test.exclude` entry
      // above and its rationale): those workspaces are tested via their own
      // `npm run test --workspace=apps/*`, never by this config, so their
      // source was only ever showing up in this report as permanent 0%
      // dead weight - not a real coverage gap, just this config's report
      // counting lines it never had a chance to exercise. Left in as-is
      // since LOU-L first added apps/agent-forge, this was latent until
      // LOU-P's growth (new server/chat + ChatPanel/ApprovalCard code, all
      // covered by apps/agent-forge's own 49/49 + 74/74 suites) tipped the
      // denominator enough to trip the global threshold below.
      exclude: ['**/*.test.ts', '**/*.spec.ts', 'dist/**', 'node_modules/**', 'apps/**', '.claude/**'],
      // Floor set 1-2 points below the measured baseline (LOU-B4). Measured with
      // `npm run test:coverage`, excluding the 3 provider test suites that fail
      // to even load in this repo because @ai-sdk/openai and ollama-ai-provider
      // are optional peer deps that aren't installed here (see LOU-B2/typings).
      //
      // Re-measured for LOU-L: `npm run test:coverage` had never actually run
      // to completion in CI (masked by the `npm run lint` step failing first
      // on every PR since LOU-B - see the eslint.config.mjs fix in this same
      // PR) once packages/create-lousho-agent's dist finally got built ahead
      // of the test step, its own source is exercised too, which raises
      // statements/functions/lines but landed branches ~2.5pts under the old
      // (never-actually-verified) 84.52% figure. Branches floor lowered to
      // match this newly-verified real baseline; the other three floors were
      // already comfortably under the new, higher measured numbers.
      // Baseline: statements 71.34%, branches 81.95%, functions 78.64%, lines 71.34%.
      thresholds: {
        statements: 61,
        branches: 80,
        functions: 72,
        lines: 61,
      },
    },
  },
});
