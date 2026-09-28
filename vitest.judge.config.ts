import { defineConfig } from 'vitest/config';

// Standalone config (NOT merged with vitest.config.ts) for LOU-G6 judge
// evals: llmJudge()-based evals call out to a real LLM provider and must
// NEVER run as part of the default `vitest run` / `npm run test:coverage`
// path. This config's `include` matches ONLY '**/*.judge.eval.ts', and the
// main vitest.config.ts (LOU-G2) explicitly excludes that same pattern
// from its own '**/*.eval.ts' include, so the two configs' file sets never
// overlap.
//
// Run explicitly via `npm run test:evals:judge`
// (`vitest run --config vitest.judge.config.ts`).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.judge.eval.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Structural (not just naming-convention) enforcement: llmJudge() itself
    // refuses to run unless this env var is set, so a misnamed/mis-globbed
    // judge-eval file picked up by the main config can't silently make a
    // real LLM call in default CI - see src/evals/llmJudge.ts.
    env: { LOUSHY_ALLOW_LLM_JUDGE: '1' },
  },
});
