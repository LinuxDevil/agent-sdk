import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runGuardrailSafely,
  Guardrail,
  ProposedAction,
  createDiffSizeGuardrail,
  secretScanGuardrail,
  createCommandGuardrail,
  createTestRunGuardrail,
  createLintGuardrail,
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

describe('command guardrails (LOU-E11)', () => {
  const fixtureRepo = path.join(__dirname, '__fixtures__', 'sample-repo');
  let scratchDir: string;
  const dummyAction: ProposedAction = { diff: '' };

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-fixture-'));
    fs.cpSync(fixtureRepo, scratchDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('createTestRunGuardrail passes against the unmutated fixture repo', async () => {
    const guardrail = createTestRunGuardrail(scratchDir);
    const result = await guardrail.check(dummyAction);
    expect(result.pass).toBe(true);
  }, 30000);

  it('createTestRunGuardrail fails when a test is mutated to fail', async () => {
    const testFile = path.join(scratchDir, 'test', 'sample.test.js');
    const original = fs.readFileSync(testFile, 'utf-8');
    fs.writeFileSync(testFile, original.replace('add(2, 3), 5', 'add(2, 3), 999'));

    const guardrail = createTestRunGuardrail(scratchDir);
    const result = await guardrail.check(dummyAction);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('test-run');
  }, 30000);

  it('createLintGuardrail passes against the unmutated fixture repo', async () => {
    const guardrail = createLintGuardrail(scratchDir);
    const result = await guardrail.check(dummyAction);
    expect(result.pass).toBe(true);
  }, 30000);

  it('createLintGuardrail fails when a lint violation is introduced', async () => {
    const srcFile = path.join(scratchDir, 'src', 'index.js');
    const original = fs.readFileSync(srcFile, 'utf-8');
    fs.writeFileSync(srcFile, `var legacy = true;\n${original}`);

    const guardrail = createLintGuardrail(scratchDir);
    const result = await guardrail.check(dummyAction);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('lint');
  }, 30000);

  it('resolves to pass:false via the E9 timeout wrapper instead of hanging, for an artificially slow command', async () => {
    // A command that sleeps far longer than the configured timeout below.
    const slowGuardrail = createCommandGuardrail(
      'slow-command',
      scratchDir,
      process.execPath,
      ['-e', 'setTimeout(() => {}, 5000)']
    );

    const start = Date.now();
    const result = await runGuardrailSafely(slowGuardrail, dummyAction, 100);
    const elapsed = Date.now() - start;

    expect(result.pass).toBe(false);
    expect(result.reason).toContain('slow-command');
    // Should resolve close to the 100ms timeout, not wait for the 5s sleep.
    expect(elapsed).toBeLessThan(2000);
  }, 10000);
});
