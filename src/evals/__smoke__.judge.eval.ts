/**
 * Smoke judge eval (LOU-G6) - a real defineEval() + llmJudge() combination,
 * using a mock judge provider that resolves generate() with a fixed
 * rubric score ("0.9"). Only collected by vitest.judge.config.ts's
 * '**\/*.judge.eval.ts' include (NOT by the default vitest.config.ts,
 * whose '**\/*.eval.ts' include explicitly excludes this filename), so run
 * this file via `npm run test:evals:judge`.
 */
import { defineEval } from './defineEval';
import { llmJudge } from './llmJudge';
import { createMockProvider } from '../providers/mock';

defineEval({
  name: 'smoke (judge): llmJudge scores a fixed judge response',
  agent: {
    name: 'Smoke Agent',
    prompt: 'You are a helpful assistant',
  },
  input: 'Summarize the weather',
  provider: createMockProvider({ name: 'mock', responses: ['It is sunny today.'] }),
  score: llmJudge({
    provider: createMockProvider({ name: 'mock-judge', responses: ['0.9'] }),
    model: 'mock-model',
    rubric: 'Score 1 if the output mentions the weather, 0 otherwise.',
  }),
  threshold: 0.8,
});
