/**
 * Smoke eval (LOU-G2) - a real, always-passing defineEval() call that
 * proves '**\/*.eval.ts' files are picked up by the default `vitest run`
 * path (wired into vitest.config.ts's test.include in this ticket).
 */
import { defineEval } from './defineEval';
import { createMockProvider } from '../providers/mock';

defineEval({
  name: 'smoke: eval files are collected by default vitest run',
  agent: {
    name: 'Smoke Agent',
    prompt: 'You are a helpful assistant',
  },
  input: 'Hello',
  provider: createMockProvider({ name: 'mock', responses: ['Hi there!'] }),
  score: (result) => (result.text.length > 0 ? 1 : 0),
  threshold: 1,
});
