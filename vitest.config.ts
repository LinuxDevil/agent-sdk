import * as path from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import pkg from './package.json';

/**
 * Examples import the SDK by its package name, like a reader's app would.
 * Under vitest those imports resolve to src/ (the same mapping as the
 * tsconfig.json `paths`), so the examples' tests need no build and never mix
 * dist/ classes with src/ ones. Scoped to examples/: other tests that import
 * the package name keep resolving to the built dist/.
 */
function examplesSelfImports(): Plugin {
  // Vite hands resolveId importers with forward slashes on every platform, so
  // the prefix is compared in that form; with path.sep this never matched on
  // Windows and examples silently ran against dist/.
  const examplesDir = path.join(__dirname, 'examples').split(path.sep).join('/') + '/';
  const targets = new Map(
    Object.entries(pkg.exports).map(([subpath, entry]) => [
      subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`,
      path
        .join(__dirname, entry.require.types.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$/, '.ts'))
        .split(path.sep)
        .join('/'),
    ])
  );
  return {
    name: 'examples-self-imports',
    enforce: 'pre',
    resolveId(id, importer) {
      return importer?.startsWith(examplesDir) ? (targets.get(id) ?? null) : null;
    },
  };
}

export default defineConfig({
  plugins: [examplesSelfImports()],
  test: {
    globals: true,
    environment: 'node',
    // A per-run TMPDIR, removed when the run ends (scripts/vitestTmpdir.ts).
    globalSetup: ['./scripts/vitestTmpdir.ts'],
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
      // Real-daemon Docker tests (LOU-M6): run only via vitest.docker.config.ts /
      // `npm run test:docker` (the Linux Docker CI job), never in the default run.
      '**/*.docker.test.ts',
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
      // Only the library source counts: scripts/, examples/ and
      // packages/ are not shipped code, and counting them (and any scratch
      // directory a test made in the repo) diluted the figure to ~82% while
      // src/ itself sat at ~96%, so the floors below caught nothing.
      include: ['src/**'],
      exclude: [
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.test-d.ts',
        '**/*.eval.ts',
        '**/__fixtures__/**',
        'dist/**',
        'node_modules/**',
        'apps/**',
        '.claude/**',
      ],
      // Floors set 1.5-2 points below the measured baseline of src/ alone
      // (`npm run test:coverage`, 2026-10): statements 96.64%, branches
      // 91.06%, functions 96.05%, lines 96.64%. They used to sit ~35 points
      // under the real figure because the denominator counted scripts/,
      // examples/ too (see `include` above).
      thresholds: {
        statements: 95,
        branches: 89,
        functions: 94,
        lines: 95,
      },
    },
  },
});
