import { describe, it, expect } from 'vitest';
import { runGuardrailSafely, Guardrail, ProposedAction } from './guardrails';

const action: ProposedAction = { diff: 'diff --git a/foo.txt b/foo.txt\n+hello\n' };

describe('runGuardrailSafely', () => {
  it('resolves to pass:false (not an unhandled rejection) when the guardrail throws', async () => {
    const throwing: Guardrail = {
      name: 'throwing-guardrail',
      check: async () => {
        throw new Error('boom');
      },
    };

    const result = await runGuardrailSafely(throwing, action);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('throwing-guardrail');
  });

  it('resolves to pass:false when the guardrail times out', async () => {
    const hanging: Guardrail = {
      name: 'hanging-guardrail',
      check: () => new Promise(() => {}), // never resolves
    };

    const result = await runGuardrailSafely(hanging, action, 25);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('hanging-guardrail');
  });

  it('passes a normally-resolving result through unchanged', async () => {
    const passing: Guardrail = {
      name: 'passing-guardrail',
      check: async () => ({ pass: true }),
    };

    const result = await runGuardrailSafely(passing, action);
    expect(result).toEqual({ pass: true });
  });

  it('passes a normally-resolving failing result through unchanged', async () => {
    const failing: Guardrail = {
      name: 'failing-guardrail',
      check: async () => ({ pass: false, reason: 'diff too big' }),
    };

    const result = await runGuardrailSafely(failing, action);
    expect(result).toEqual({ pass: false, reason: 'diff too big' });
  });
});
