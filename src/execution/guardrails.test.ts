import { describe, it, expect } from 'vitest';
import {
  runGuardrailSafely,
  Guardrail,
  ProposedAction,
  createDiffSizeGuardrail,
  secretScanGuardrail,
} from './guardrails';

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

describe('createDiffSizeGuardrail', () => {
  it('rejects a diff with N+1 lines against an N-line threshold', async () => {
    const guardrail = createDiffSizeGuardrail(5);
    const diff = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n');

    const result = await guardrail.check({ diff });
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('5');
  });

  it('passes a diff at or under the threshold', async () => {
    const guardrail = createDiffSizeGuardrail(5);
    const diff = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');

    const result = await guardrail.check({ diff });
    expect(result.pass).toBe(true);
  });
});

describe('secretScanGuardrail', () => {
  it('rejects a diff containing a private key header', async () => {
    const diff = '+-----BEGIN RSA PRIVATE KEY-----\n+MIIExampleKeyMaterial\n';
    const result = await secretScanGuardrail.check({ diff });
    expect(result.pass).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('rejects a diff containing an OpenAI-style key', async () => {
    const diff = '+const key = "sk-abcdefghijklmnopqrstuvwx";\n';
    const result = await secretScanGuardrail.check({ diff });
    expect(result.pass).toBe(false);
  });

  it('rejects a diff containing an AWS access key', async () => {
    const diff = '+AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\n';
    const result = await secretScanGuardrail.check({ diff });
    expect(result.pass).toBe(false);
  });

  it('passes a clean diff', async () => {
    const diff = 'diff --git a/foo.txt b/foo.txt\n+hello world\n-goodbye\n';
    const result = await secretScanGuardrail.check({ diff });
    expect(result.pass).toBe(true);
  });
});
