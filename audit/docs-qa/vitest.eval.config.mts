// Own vitest config for `lousho eval --config`: the generated one keeps vitest's
// 5 s default testTimeout, which no live/record/drift case on a real model meets.
export default {
  test: {
    globals: true,
    environment: 'node',
    include: ['evals/**/*.eval.ts'],
    exclude: ['**/node_modules/**', '**/*.judge.eval.*'],
    testTimeout: 15 * 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
};
