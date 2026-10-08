export default {
  test: {
    globals: true,
    environment: 'node',
    include: ['evals/**/*.judge.eval.ts'],
    testTimeout: 15 * 60_000,
    fileParallelism: false,
  },
};
