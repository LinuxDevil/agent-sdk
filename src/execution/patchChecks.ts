/**
 * Patch checks
 * Pluggable pre-flight checks run against a proposed patch (e.g. a diff
 * about to be committed/PR'd) before it's allowed through (LOU-E9+).
 * Named "patch checks" - not "guardrails" - so "guardrail" keeps its one
 * meaning: the input/output/tool guardrails of ioGuardrails.ts (A5).
 */

import { execFile, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SECRET_PATTERNS } from './secretPatterns';

const execFileAsync = promisify(execFile);

/**
 * Runs `command args...` in `cwd`, resolving to a PatchCheckResult that
 * passes iff the process exits 0 - and, if it doesn't settle within
 * `timeoutMs`, kills it and resolves pass:false instead of leaving it
 * running in the background (LOU-E fix; see createCommandCheck's own
 * doc comment for why this timeout lives here rather than as a second
 * mechanism competing with runPatchCheckSafely's outer race).
 *
 * Uses `execFile` directly (not the promisified wrapper) specifically so
 * the returned `ChildProcess` handle is available to kill on timeout. An
 * earlier version of this used an AbortController's `signal` passed into
 * the promisified execFile instead; that only killed the *direct* child,
 * which on Windows (where this always runs with `shell: true` to invoke
 * npm's .cmd shim) is the cmd.exe shell, not the real npm/node process -
 * so the actual work kept running, orphaned, after "timeout" resolved.
 * See killProcessTree() below for how this version actually reaches it.
 */
function runCommandWithTimeout(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<PatchCheckResult> {
  return new Promise((resolve) => {
    let timedOut = false;

    const child: ChildProcess = execFile(
      command,
      args,
      // On Windows, npm (and other npm-installed CLIs) are .cmd shims
      // that execFile can only invoke through a shell.
      { cwd, shell: process.platform === 'win32' },
      (error, _stdout, stderr) => {
        clearTimeout(timer);
        if (timedOut) {
          // The timeout branch below already resolved; a late exit/error
          // callback after that must not resolve (or reason-overwrite) a
          // second time.
          return;
        }
        if (error) {
          const err = error as { code?: number | string; message: string };
          const stderrText = (stderr || '').toString().trim();
          resolve({
            pass: false,
            reason: `${name} failed (exit code ${err.code ?? 'unknown'})${
              stderrText ? `: ${stderrText}` : `: ${err.message}`
            }`,
          });
          return;
        }
        resolve({ pass: true });
      }
    );

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      resolve({
        pass: false,
        reason: `${name} timed out after ${timeoutMs}ms and was killed`,
      });
    }, timeoutMs);
  });
}

/**
 * Kills `child` and, on Windows, its whole descendant process tree.
 *
 * A plain `child.kill()` only signals the direct child. That's sufficient
 * on POSIX, but on Windows this function always runs with `shell: true`
 * (needed to invoke npm's .cmd shim), which means `child` is actually the
 * cmd.exe shell process - the real `npm`/`node` work runs as ITS child.
 * Killing just the shell leaves that real work orphaned and still running
 * (verified directly: a plain `child.kill()` - and, before that, an
 * AbortController `signal` passed into execFile, which has the same
 * "only kills the direct child" limitation - both left the spawned
 * process alive and holding an open file handle in its scratch dir even
 * after the shell process itself was gone). `taskkill /T` walks and kills
 * the entire process tree rooted at the shell's PID instead, which
 * actually terminates the real work.
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  } else {
    child.kill('SIGTERM');
  }
}

/**
 * The diff a patch check vets. It is a minimal shape: `diff` is the
 * unified diff the patch would apply, which the checks measure (line
 * count), scan (secret patterns) or apply to a scratch checkout before
 * running a command (test runner).
 */
export interface ProposedPatch {
  diff: string;
}

/**
 * The result of running a single PatchCheck against a ProposedPatch.
 */
export interface PatchCheckResult {
  pass: boolean;
  reason?: string;
}

/**
 * A single named pre-flight check.
 */
export interface PatchCheck {
  name: string;
  check(patch: ProposedPatch): Promise<PatchCheckResult>;
}

/**
 * Runs `check.check(patch)` fail-closed: if it throws, rejects, or
 * doesn't settle within `timeoutMs`, this resolves to
 * `{ pass: false, reason: '<name> threw or timed out' }` instead of
 * throwing or hanging - a check that can't be evaluated must never be
 * silently treated as passing.
 */
export async function runPatchCheckSafely(
  check: PatchCheck,
  patch: ProposedPatch,
  timeoutMs = 30000
): Promise<PatchCheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<PatchCheckResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ pass: false, reason: `${check.name} threw or timed out` });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      check.check(patch).catch(
        (): PatchCheckResult => ({
          pass: false,
          reason: `${check.name} threw or timed out`,
        })
      ),
      timeout,
    ]);
    // Normalize pass to a strict boolean here too, so every caller of
    // runPatchCheckSafely (not just runPatchChecks' own aggregation) gets a
    // well-typed result even from a third-party/JS PatchCheck that resolves
    // with something truthy-but-non-boolean (e.g. `{ pass: 1 }`).
    return { ...result, pass: result.pass === true };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Rejects a diff with more than `maxLines` lines.
 */
export function createDiffSizeCheck(maxLines: number): PatchCheck {
  return {
    name: 'diff-size-cap',
    async check(patch: ProposedPatch): Promise<PatchCheckResult> {
      const actualLines = patch.diff.split('\n').length;
      if (actualLines > maxLines) {
        return {
          pass: false,
          reason: `diff has ${actualLines} lines, exceeding the ${maxLines}-line threshold`,
        };
      }
      return { pass: true };
    },
  };
}

/**
 * Rejects a diff containing anything that looks like a committed secret
 * (private key material, an OpenAI-style API key, or an AWS access key).
 *
 * The rejection reason names the pattern's label only, never the matched
 * text (LOU-R2): the reason travels into events, traces and logs, and
 * copying the secret there would leak the very thing the check exists
 * to keep out - the same rule the ioGuardrails trip-info docs state.
 */
export const secretScanCheck: PatchCheck = {
  name: 'secret-scan',
  async check(patch: ProposedPatch): Promise<PatchCheckResult> {
    for (const { label, pattern } of SECRET_PATTERNS) {
      if (pattern.test(patch.diff)) {
        return {
          pass: false,
          reason: `diff appears to contain a ${label}`,
        };
      }
    }
    return { pass: true };
  },
};

/**
 * Options for {@link createCommandCheck}.
 */
export interface CommandCheckOptions {
  /**
   * How long (ms) the check's own internal command execution is
   * allowed to run before it kills the child process itself. Defaults to
   * 30000, matching runPatchCheckSafely()'s own default timeout. Callers
   * that pass a custom timeoutMs to runPatchCheckSafely() should pass the
   * same value here so the check's own process-owning timeout - not
   * just the outer race - is the one that actually fires first and kills
   * the child (see the "process leak" note below).
   */
  timeoutMs?: number;
}

/**
 * Builds a PatchCheck that:
 *  1. If `patch.diff` is a non-empty string, applies it to a fresh
 *     temporary copy of `cwd` via `git apply` (LOU-E fix: previously this
 *     check ignored `patch.diff` entirely and just ran the command
 *     against whatever was already on disk at `cwd`, so it never actually
 *     gated the diff it was supposed to be checking). The diff is first
 *     validated with `git apply --check`; if it doesn't apply cleanly,
 *     that itself is reported as a check failure rather than throwing.
 *     `cwd` itself is never mutated - only the temp copy is.
 *  2. If `patch.diff` is empty/undefined, this is treated as a
 *     deliberate "no diff to gate" case: the command just runs directly
 *     against `cwd` as-is (this is also what lets existing "fixture repo
 *     already broken" tests keep working unchanged).
 *  3. Runs `command args...` in the (possibly patched) working directory
 *     and passes iff the process exits 0.
 *
 * Used for both the test-run and lint checks below (and reusable for
 * any other "run this command, pass on exit 0" check) so that logic isn't
 * duplicated per check.
 *
 * Process-leak note (LOU-E fix): runPatchCheckSafely() (LOU-E9) races every
 * check (including this one) against its own outer timeout, and
 * per LOU-E11's own design note, this function deliberately does NOT add a
 * second, independent timeout mechanism competing with that race. Instead,
 * the single timeout owned here (see runCommandWithTimeout() below) is the
 * one that actually executes the command and is able to kill it: it holds
 * a direct handle to the spawned ChildProcess (via `execFile`, not its
 * promisified wrapper) and kills it - and, on Windows, its whole
 * descendant process tree via `taskkill /T` (see killProcessTree()'s doc
 * comment for why a plain kill() isn't enough there) - when `timeoutMs`
 * elapses, rather than just abandoning it in the background the way an
 * outer Promise.race alone would. Callers that also pass a custom
 * timeoutMs to runPatchCheckSafely() should pass a matching (or smaller)
 * timeoutMs here so this internal timeout - the one that owns process
 * cleanup - is the one that actually fires.
 */
export function createCommandCheck(
  name: string,
  cwd: string,
  command: string,
  args: string[],
  options: CommandCheckOptions = {}
): PatchCheck {
  const { timeoutMs = 30000 } = options;

  return {
    name,
    async check(patch: ProposedPatch): Promise<PatchCheckResult> {
      let scratchDir: string | undefined;

      try {
        let workDir = cwd;

        if (patch.diff && patch.diff.trim().length > 0) {
          scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-check-apply-'));
          fs.cpSync(cwd, scratchDir, { recursive: true });
          workDir = scratchDir;

          const diffFile = path.join(scratchDir, '.patch-check-diff.patch');
          fs.writeFileSync(diffFile, patch.diff);

          try {
            await execFileAsync('git', ['apply', '--check', diffFile], { cwd: scratchDir });
          } catch (checkError) {
            const err = checkError as { stderr?: string; message: string };
            const detail = (err.stderr || err.message || '').toString().trim();
            return {
              pass: false,
              reason: `${name}: diff does not apply cleanly${detail ? `: ${detail}` : ''}`,
            };
          }

          await execFileAsync('git', ['apply', diffFile], { cwd: scratchDir });
          fs.rmSync(diffFile, { force: true });
        }

        return await runCommandWithTimeout(name, command, args, workDir, timeoutMs);
      } finally {
        if (scratchDir) {
          fs.rmSync(scratchDir, { recursive: true, force: true });
        }
      }
    },
  };
}

/**
 * Runs `npm test` in `repoPath` and passes iff it exits 0.
 */
export function createTestRunCheck(
  repoPath: string,
  options?: CommandCheckOptions
): PatchCheck {
  return createCommandCheck('test-run', repoPath, 'npm', ['test'], options);
}

/**
 * Runs `npm run lint` in `repoPath` and passes iff it exits 0.
 */
export function createLintCheck(
  repoPath: string,
  options?: CommandCheckOptions
): PatchCheck {
  return createCommandCheck('lint', repoPath, 'npm', ['run', 'lint'], options);
}

/**
 * The result of running a full set of patch checks against a ProposedPatch.
 */
export interface RunPatchChecksResult {
  pass: boolean;
  failures: { name: string; reason?: string }[];
}

/**
 * Runs every check in `checks` against `patch` concurrently
 * (Promise.all, not a sequential loop - so total wall time tracks the
 * slowest check rather than their sum) via runPatchCheckSafely()
 * (LOU-E9), and rolls the results up into a single pass/fail plus the
 * list of checks that failed.
 */
export async function runPatchChecks(
  patch: ProposedPatch,
  checks: PatchCheck[]
): Promise<RunPatchChecksResult> {
  const results = await Promise.all(
    checks.map(async (check) => ({
      name: check.name,
      result: await runPatchCheckSafely(check, patch),
    }))
  );

  // Strict `=== true` check (not just truthiness) so a third-party/JS
  // PatchCheck resolving with a truthy-but-non-boolean `pass` (e.g.
  // `{ pass: 1 }`) is correctly treated as a failure rather than silently
  // passing - this is a security-relevant gate, so "well-typed TypeScript
  // caller" isn't a safe assumption to lean on.
  const failures = results
    .filter(({ result }) => result.pass !== true)
    .map(({ name, result }) => ({ name, reason: result.reason }));

  return {
    pass: failures.length === 0,
    failures,
  };
}
