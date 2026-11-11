import type { Check } from '../../evals/checks';

export function outputFieldCheck(field: string): Check<Record<string, unknown>> {
  return {
    evaluate: (output) => {
      const value = output[field];
      const passed = typeof value === 'string' && value.trim().length > 0;
      return { score: passed ? 1 : 0, passed, threshold: 1, message: passed ? undefined : `output.${field} is missing or empty` };
    },
  };
}
