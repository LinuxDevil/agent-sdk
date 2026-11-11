import type { Check } from '../../../../../evals/checks';

const check: Check<Record<string, unknown>> = {
  evaluate: (output) => {
    const passed = Object.values(output).some((value) => typeof value === 'string' && value.trim().length > 0);
    return { score: passed ? 1 : 0, passed, threshold: 1, message: passed ? undefined : 'output has no non-empty text field' };
  },
};

export default check;
