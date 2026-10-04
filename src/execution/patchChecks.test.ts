import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runPatchCheckSafely,
  PatchCheck,
  ProposedPatch,
  createDiffSizeCheck,
  secretScanCheck,
  createCommandCheck,
  createTestRunCheck,
  createLintCheck,
  runPatchChecks,
} from './patchChecks';
import { SECRET_PATTERNS } from './secretPatterns';

const action: ProposedPatch = { diff: 'diff --git a/foo.txt b/foo.txt\n+hello\n' };

describe('runPatchCheckSafely', () => {
  it('resolves to pass:false (not an unhandled rejection) when the check throws', async () => {
    const throwing: PatchCheck = {
      name: 'throwing-check',
      check: async () => {
        throw new Error('boom');
      },
    };

    const result = await runPatchCheckSafely(throwing, action);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('throwing-check');
  });

  it('resolves to pass:false when the check times out', async () => {
    const hanging: PatchCheck = {
      name: 'hanging-check',
      check: () => new Promise(() => {}), // never resolves
    };

    const result = await runPatchCheckSafely(hanging, action, 25);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('hanging-check');
  });

  it('passes a normally-resolving result through unchanged', async () => {
    const passing: PatchCheck = {
      name: 'passing-check',
      check: async () => ({ pass: true }),
    };

    const result = await runPatchCheckSafely(passing, action);
    expect(result).toEqual({ pass: true });
  });

  it('passes a normally-resolving failing result through unchanged', async () => {
    const failing: PatchCheck = {
      name: 'failing-check',
      check: async () => ({ pass: false, reason: 'diff too big' }),
    };

    const result = await runPatchCheckSafely(failing, action);
    expect(result).toEqual({ pass: false, reason: 'diff too big' });
  });
});

describe('createDiffSizeCheck', () => {
  it('rejects a diff with N+1 lines against an N-line threshold', async () => {
    const check = createDiffSizeCheck(5);
    const diff = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n');

    const result = await check.check({ diff });
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('5');
  });

  it('passes a diff at or under the threshold', async () => {
    const check = createDiffSizeCheck(5);
    const diff = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');

    const result = await check.check({ diff });
    expect(result.pass).toBe(true);
  });
});

describe('secretScanCheck', () => {
  it('rejects a diff containing a private key header', async () => {
    const diff = '+-----BEGIN RSA PRIVATE KEY-----\n+MIIExampleKeyMaterial\n';
    const result = await secretScanCheck.check({ diff });
    expect(result.pass).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('rejects a diff containing an OpenAI-style key', async () => {
    const diff = '+const key = "sk-abcdefghijklmnopqrstuvwx";\n';
    const result = await secretScanCheck.check({ diff });
    expect(result.pass).toBe(false);
  });

  it('rejects a diff containing an AWS access key', async () => {
    const diff = '+AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\n';
    const result = await secretScanCheck.check({ diff });
    expect(result.pass).toBe(false);
  });

  it('passes a clean diff', async () => {
    const diff = 'diff --git a/foo.txt b/foo.txt\n+hello world\n-goodbye\n';
    const result = await secretScanCheck.check({ diff });
    expect(result.pass).toBe(true);
  });

  it('never puts the matched secret in the reason (LOU-R2): only the pattern label', async () => {
    // One fake secret per SECRET_PATTERNS entry. The rejection reason (and
    // the failure runPatchChecks() reports from it) names the label only -
    // embedding the matched text would copy the secret into events, traces
    // and logs.
    const secrets = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'sk-FakeTestKey1234567890AbCdEfGh',
      'AKIA0123456789ABCDEF',
    ];
    for (const secret of secrets) {
      const diff = `+const key = "${secret}";\n`;
      const matched = SECRET_PATTERNS.map(({ pattern }) => diff.match(pattern)?.[0]).find(Boolean);
      expect(matched).toBe(secret);

      const result = await secretScanCheck.check({ diff });
      expect(result.pass).toBe(false);
      expect(result.reason).toBeDefined();
      expect(result.reason).not.toContain(secret);

      const aggregated = await runPatchChecks({ diff }, [secretScanCheck]);
      expect(aggregated.pass).toBe(false);
      for (const failure of aggregated.failures) {
        expect(failure.reason ?? '').not.toContain(secret);
      }
    }
  });
});

describe('command patch checks (LOU-E11)', () => {
  const fixtureRepo = path.join(__dirname, '__fixtures__', 'sample-repo');
  let scratchDir: string;
  const dummyPatch: ProposedPatch = { diff: '' };

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-checks-fixture-'));
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

  it('createTestRunCheck passes against the unmutated fixture repo', async () => {
    const check = createTestRunCheck(scratchDir);
    const result = await check.check(dummyPatch);
    expect(result.pass).toBe(true);
  }, 30000);

  it('createTestRunCheck fails when a test is mutated to fail', async () => {
    const testFile = path.join(scratchDir, 'test', 'sample.test.js');
    const original = fs.readFileSync(testFile, 'utf-8');
    fs.writeFileSync(testFile, original.replace('add(2, 3), 5', 'add(2, 3), 999'));

    const check = createTestRunCheck(scratchDir);
    const result = await check.check(dummyPatch);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('test-run');
  }, 30000);

  it('createLintCheck passes against the unmutated fixture repo', async () => {
    const check = createLintCheck(scratchDir);
    const result = await check.check(dummyPatch);
    expect(result.pass).toBe(true);
  }, 30000);

  it('createLintCheck fails when a lint violation is introduced', async () => {
    const srcFile = path.join(scratchDir, 'src', 'index.js');
    const original = fs.readFileSync(srcFile, 'utf-8');
    fs.writeFileSync(srcFile, `var legacy = true;\n${original}`);

    const check = createLintCheck(scratchDir);
    const result = await check.check(dummyPatch);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('lint');
  }, 30000);

  it('resolves to pass:false via the E9 timeout wrapper instead of hanging, for an artificially slow command', async () => {
    // A command that sleeps far longer than the configured timeout below.
    const slowCheck = createCommandCheck(
      'slow-command',
      scratchDir,
      process.execPath,
      ['-e', 'setTimeout(() => {}, 5000)']
    );

    const start = Date.now();
    const result = await runPatchCheckSafely(slowCheck, dummyPatch, 100);
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

    const slowCheck = createCommandCheck(
      'leak-check-command',
      scratchDir,
      'node',
      [scriptFile, pidFile],
      { timeoutMs: 150 }
    );

    const result = await runPatchCheckSafely(slowCheck, dummyPatch, 150);
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
    // beforeEach-created scratchDir) - createCommandCheck must make
    // its own internal copy to apply the diff into, never touching this.
    const check = createTestRunCheck(fixtureRepo);
    const result = await check.check({ diff });

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
    const check = createTestRunCheck(scratchDir);
    const result = await check.check({ diff: '' });
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

    const check = createTestRunCheck(scratchDir);
    const result = await check.check({ diff: badDiff });

    expect(result.pass).toBe(false);
    expect(result.reason).toContain('does not apply cleanly');
  }, 30000);
});

describe('runPatchChecks (LOU-E12)', () => {
  it('runs all checks and reports overall fail naming the failing one', async () => {
    const passingA: PatchCheck = { name: 'a', check: async () => ({ pass: true }) };
    const passingB: PatchCheck = { name: 'b', check: async () => ({ pass: true }) };
    const failingC: PatchCheck = {
      name: 'c',
      check: async () => ({ pass: false, reason: 'c is broken' }),
    };

    const result = await runPatchChecks(action, [passingA, passingB, failingC]);

    expect(result.pass).toBe(false);
    expect(result.failures).toEqual([{ name: 'c', reason: 'c is broken' }]);
  });

  it('treats a truthy-but-non-boolean pass value as a failure, not a pass (LOU-E fix)', async () => {
    const sloppy: PatchCheck = {
      name: 'sloppy',
      // Simulates a third-party/JS check that isn't well-typed and
      // resolves `pass` to a truthy number instead of `true`.
      check: async () => ({ pass: 1 as unknown as boolean }),
    };

    const safeResult = await runPatchCheckSafely(sloppy, action);
    expect(safeResult.pass).toBe(false);

    const result = await runPatchChecks(action, [sloppy]);
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual([{ name: 'sloppy', reason: undefined }]);
  });

  it('reports overall pass when every check passes', async () => {
    const passingA: PatchCheck = { name: 'a', check: async () => ({ pass: true }) };
    const passingB: PatchCheck = { name: 'b', check: async () => ({ pass: true }) };

    const result = await runPatchChecks(action, [passingA, passingB]);

    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('runs checks concurrently, not sequentially (wall time tracks the max delay, not the sum)', async () => {
    const delay = (ms: number): PatchCheck => ({
      name: `delay-${ms}`,
      check: async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { pass: true };
      },
    });

    const start = Date.now();
    await runPatchChecks(action, [delay(50), delay(200)]);
    const elapsed = Date.now() - start;

    // Sequential would be ~250ms; concurrent should be close to ~200ms.
    // Generous tolerance to avoid CI flakiness.
    expect(elapsed).toBeLessThan(250);
  });
});
