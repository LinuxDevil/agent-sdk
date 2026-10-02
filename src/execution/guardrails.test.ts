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
  runGuardrails,
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

  afterEach(async () => {
    // The timeout test's child is killed by a taskkill nobody waits for; on
    // Windows its working directory stays locked (EPERM) until it exits.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 50) throw error;
        await new Promise((done) => setTimeout(done, 200));
      }
    }
  }, 15_000);

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

  it('kills the underlying child process on timeout instead of leaking it (LOU-E fix)', async () => {
    // A long-sleeping child that writes its own PID to a file as soon as
    // it starts, so the test can check afterwards whether that PID is
    // still alive - proving the process was actually terminated, not just
    // abandoned by the outer race. Run from a script file (rather than
    // `node -e "..."` inline) so this doesn't depend on shell-quoting
    // behavior for paths/quotes on Windows.
    const pidFile = path.join(scratchDir, 'child.pid');
    const scriptFile = path.join(scratchDir, 'sleeper.js');
    fs.writeFileSync(
      scriptFile,
      "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 5000);"
    );

    const slowGuardrail = createCommandGuardrail(
      'leak-check-command',
      scratchDir,
      'node',
      [scriptFile, pidFile],
      { timeoutMs: 150 }
    );

    const result = await runGuardrailSafely(slowGuardrail, dummyAction, 150);
    expect(result.pass).toBe(false);

    // Give the OS a moment to actually finish tearing the process down
    // after it was signaled (taskkill on Windows, in particular, isn't
    // instantaneous).
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());

    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 10000);

  it('applies action.diff to a scratch copy and evaluates the patched result, without mutating the fixture (LOU-E fix)', async () => {
    // A small valid unified diff against the pristine fixture repo that
    // breaks the one existing test when applied.
    const diff = [
      'diff --git a/test/sample.test.js b/test/sample.test.js',
      'index 0000000..1111111 100644',
      '--- a/test/sample.test.js',
      '+++ b/test/sample.test.js',
      '@@ -1,7 +1,7 @@',
      " const test = require('node:test');",
      " const assert = require('node:assert');",
      " const { add } = require('../src/index');",
      ' ',
      " test('add() sums two numbers', () => {",
      '-  assert.strictEqual(add(2, 3), 5);',
      '+  assert.strictEqual(add(2, 3), 999);',
      ' });',
      '',
    ].join('\n');

    const originalFixtureContent = fs.readFileSync(
      path.join(fixtureRepo, 'test', 'sample.test.js'),
      'utf-8'
    );

    // Passed directly against the pristine, checked-in fixture (not the
    // beforeEach-created scratchDir) - createCommandGuardrail must make
    // its own internal copy to apply the diff into, never touching this.
    const guardrail = createTestRunGuardrail(fixtureRepo);
    const result = await guardrail.check({ diff });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain('test-run');

    // The checked-in fixture must remain byte-for-byte unmutated.
    const afterFixtureContent = fs.readFileSync(
      path.join(fixtureRepo, 'test', 'sample.test.js'),
      'utf-8'
    );
    expect(afterFixtureContent).toBe(originalFixtureContent);
  }, 30000);

  it('an empty/undefined diff runs the command against repoPath as-is (deliberate "no diff to gate" case)', async () => {
    const guardrail = createTestRunGuardrail(scratchDir);
    const result = await guardrail.check({ diff: '' });
    expect(result.pass).toBe(true);
  }, 30000);

  it('rejects a diff that does not apply cleanly with a clear reason', async () => {
    const badDiff = [
      'diff --git a/test/sample.test.js b/test/sample.test.js',
      'index 0000000..1111111 100644',
      '--- a/test/sample.test.js',
      '+++ b/test/sample.test.js',
      '@@ -1,3 +1,3 @@',
      ' this context line does not exist in the real file',
      '-neither does this one',
      '+nor this replacement',
      '',
    ].join('\n');

    const guardrail = createTestRunGuardrail(scratchDir);
    const result = await guardrail.check({ diff: badDiff });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain('does not apply cleanly');
  }, 30000);
});

describe('runGuardrails (LOU-E12)', () => {
  it('runs all guardrails and reports overall fail naming the failing one', async () => {
    const passingA: Guardrail = { name: 'a', check: async () => ({ pass: true }) };
    const passingB: Guardrail = { name: 'b', check: async () => ({ pass: true }) };
    const failingC: Guardrail = {
      name: 'c',
      check: async () => ({ pass: false, reason: 'c is broken' }),
    };

    const result = await runGuardrails(action, [passingA, passingB, failingC]);

    expect(result.pass).toBe(false);
    expect(result.failures).toEqual([{ name: 'c', reason: 'c is broken' }]);
  });

  it('treats a truthy-but-non-boolean pass value as a failure, not a pass (LOU-E fix)', async () => {
    const sloppy: Guardrail = {
      name: 'sloppy',
      // Simulates a third-party/JS guardrail that isn't well-typed and
      // resolves `pass` to a truthy number instead of `true`.
      check: async () => ({ pass: 1 as unknown as boolean }),
    };

    const safeResult = await runGuardrailSafely(sloppy, action);
    expect(safeResult.pass).toBe(false);

    const result = await runGuardrails(action, [sloppy]);
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual([{ name: 'sloppy', reason: undefined }]);
  });

  it('reports overall pass when every guardrail passes', async () => {
    const passingA: Guardrail = { name: 'a', check: async () => ({ pass: true }) };
    const passingB: Guardrail = { name: 'b', check: async () => ({ pass: true }) };

    const result = await runGuardrails(action, [passingA, passingB]);

    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('runs guardrails concurrently, not sequentially (wall time tracks the max delay, not the sum)', async () => {
    const delay = (ms: number): Guardrail => ({
      name: `delay-${ms}`,
      check: async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { pass: true };
      },
    });

    const start = Date.now();
    await runGuardrails(action, [delay(50), delay(200)]);
    const elapsed = Date.now() - start;

    // Sequential would be ~250ms; concurrent should be close to ~200ms.
    // Generous tolerance to avoid CI flakiness.
    expect(elapsed).toBeLessThan(250);
  });
});
