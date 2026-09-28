/**
 * Guardrails
 * Pluggable pre-flight checks run against a proposed agent action (e.g. a
 * diff about to be committed/PR'd) before it's allowed through (LOU-E9+).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * A proposed action for guardrails to vet. Minimal placeholder shape -
 * LOU-J (not yet landed) is expected to define the real ProposedAction
 * (and richer action types) that this SDK's PR-authoring flow produces;
 * this stands in for it so guardrails.ts has something concrete to type
 * against in the meantime.
 */
export interface ProposedAction {
  diff: string;
}

/**
 * The result of running a single Guardrail against a ProposedAction.
 */
export interface GuardrailResult {
  pass: boolean;
  reason?: string;
}

/**
 * A single named pre-flight check.
 */
export interface Guardrail {
  name: string;
  check(action: ProposedAction): Promise<GuardrailResult>;
}

/**
 * Runs `guardrail.check(action)` fail-closed: if it throws, rejects, or
 * doesn't settle within `timeoutMs`, this resolves to
 * `{ pass: false, reason: '<name> threw or timed out' }` instead of
 * throwing or hanging - a guardrail that can't be evaluated must never be
 * silently treated as passing.
 */
export async function runGuardrailSafely(
  guardrail: Guardrail,
  action: ProposedAction,
  timeoutMs = 30000
): Promise<GuardrailResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<GuardrailResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ pass: false, reason: `${guardrail.name} threw or timed out` });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      guardrail.check(action).catch(
        (): GuardrailResult => ({
          pass: false,
          reason: `${guardrail.name} threw or timed out`,
        })
      ),
      timeout,
    ]);
    // Normalize pass to a strict boolean here too, so every caller of
    // runGuardrailSafely (not just runGuardrails' own aggregation) gets a
    // well-typed result even from a third-party/JS Guardrail that resolves
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
export function createDiffSizeGuardrail(maxLines: number): Guardrail {
  return {
    name: 'diff-size-cap',
    async check(action: ProposedAction): Promise<GuardrailResult> {
      const actualLines = action.diff.split('\n').length;
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
 * Patterns for content that must never appear in a diff about to be
 * committed/PR'd. Kept intentionally small and specific (as opposed to a
 * broad secret-detection library) to minimize false positives; extend
 * with more patterns as needed.
 */
const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'private key header', pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
  { label: 'OpenAI-style API key', pattern: /sk-[A-Za-z0-9]{20,}/ },
  { label: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
];

/**
 * Rejects a diff containing anything that looks like a committed secret
 * (private key material, an OpenAI-style API key, or an AWS access key).
 */
export const secretScanGuardrail: Guardrail = {
  name: 'secret-scan',
  async check(action: ProposedAction): Promise<GuardrailResult> {
    for (const { label, pattern } of SECRET_PATTERNS) {
      const match = action.diff.match(pattern);
      if (match) {
        return {
          pass: false,
          reason: `diff appears to contain a ${label} (matched "${match[0]}")`,
        };
      }
    }
    return { pass: true };
  },
};

/**
 * Options for {@link createCommandGuardrail}.
 */
export interface CommandGuardrailOptions {
  /**
   * How long (ms) the guardrail's own internal command execution is
   * allowed to run before it aborts the child process itself. Defaults to
   * 30000, matching runGuardrailSafely()'s own default timeout. Callers
   * that pass a custom timeoutMs to runGuardrailSafely() should pass the
   * same value here so the guardrail's own process-owning timeout - not
   * just the outer race - is the one that actually fires first and kills
   * the child (see the "process leak" note below).
   */
  timeoutMs?: number;
}

/**
 * Builds a Guardrail that:
 *  1. If `action.diff` is a non-empty string, applies it to a fresh
 *     temporary copy of `cwd` via `git apply` (LOU-E fix: previously this
 *     guardrail ignored `action.diff` entirely and just ran the command
 *     against whatever was already on disk at `cwd`, so it never actually
 *     gated the diff it was supposed to be checking). The diff is first
 *     validated with `git apply --check`; if it doesn't apply cleanly,
 *     that itself is reported as a guardrail failure rather than throwing.
 *     `cwd` itself is never mutated - only the temp copy is.
 *  2. If `action.diff` is empty/undefined, this is treated as a
 *     deliberate "no diff to gate" case: the command just runs directly
 *     against `cwd` as-is (this is also what lets existing "fixture repo
 *     already broken" tests keep working unchanged).
 *  3. Runs `command args...` in the (possibly patched) working directory
 *     and passes iff the process exits 0.
 *
 * Used for both the test-run and lint guardrails below (and reusable for
 * any other "run this command, pass on exit 0" check) so that logic isn't
 * duplicated per guardrail.
 *
 * Process-leak note (LOU-E fix): runGuardrailSafely() (LOU-E9) races every
 * guardrail (including this one) against its own outer timeout, and
 * per LOU-E11's own design note, this function deliberately does NOT add a
 * second, independent timeout mechanism competing with that race. Instead,
 * the single timeout owned here is the one that actually executes the
 * command and is able to kill it: it's implemented via an AbortController
 * whose signal is passed straight into execFile, so Node kills the child
 * process itself when `timeoutMs` elapses, rather than just abandoning it
 * in the background the way an outer Promise.race alone would. Callers
 * that also pass a custom timeoutMs to runGuardrailSafely() should pass a
 * matching (or smaller) timeoutMs here so this internal timeout - the one
 * that owns process cleanup - is the one that actually fires.
 */
export function createCommandGuardrail(
  name: string,
  cwd: string,
  command: string,
  args: string[],
  options: CommandGuardrailOptions = {}
): Guardrail {
  const { timeoutMs = 30000 } = options;

  return {
    name,
    async check(action: ProposedAction): Promise<GuardrailResult> {
      let scratchDir: string | undefined;

      try {
        let workDir = cwd;

        if (action.diff && action.diff.trim().length > 0) {
          scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-apply-'));
          fs.cpSync(cwd, scratchDir, { recursive: true });
          workDir = scratchDir;

          const diffFile = path.join(scratchDir, '.guardrail-diff.patch');
          fs.writeFileSync(diffFile, action.diff);

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

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          // On Windows, npm (and other npm-installed CLIs) are .cmd shims
          // that execFile can only invoke through a shell.
          await execFileAsync(command, args, {
            cwd: workDir,
            shell: process.platform === 'win32',
            signal: controller.signal,
          });
          return { pass: true };
        } catch (error) {
          const err = error as {
            code?: number | string;
            stderr?: string;
            message: string;
            name?: string;
          };
          if (err.name === 'AbortError') {
            return {
              pass: false,
              reason: `${name} timed out after ${timeoutMs}ms and was killed`,
            };
          }
          const stderr = (err.stderr || '').toString().trim();
          return {
            pass: false,
            reason: `${name} failed (exit code ${err.code ?? 'unknown'})${
              stderr ? `: ${stderr}` : `: ${err.message}`
            }`,
          };
        } finally {
          clearTimeout(timer);
        }
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
export function createTestRunGuardrail(
  repoPath: string,
  options?: CommandGuardrailOptions
): Guardrail {
  return createCommandGuardrail('test-run', repoPath, 'npm', ['test'], options);
}

/**
 * Runs `npm run lint` in `repoPath` and passes iff it exits 0.
 */
export function createLintGuardrail(
  repoPath: string,
  options?: CommandGuardrailOptions
): Guardrail {
  return createCommandGuardrail('lint', repoPath, 'npm', ['run', 'lint'], options);
}

/**
 * The result of running a full set of guardrails against a ProposedAction.
 */
export interface RunGuardrailsResult {
  pass: boolean;
  failures: { name: string; reason?: string }[];
}

/**
 * Runs every guardrail in `guardrails` against `action` concurrently
 * (Promise.all, not a sequential loop - so total wall time tracks the
 * slowest guardrail rather than their sum) via runGuardrailSafely()
 * (LOU-E9), and rolls the results up into a single pass/fail plus the
 * list of guardrails that failed.
 */
export async function runGuardrails(
  action: ProposedAction,
  guardrails: Guardrail[]
): Promise<RunGuardrailsResult> {
  const results = await Promise.all(
    guardrails.map(async (guardrail) => ({
      name: guardrail.name,
      result: await runGuardrailSafely(guardrail, action),
    }))
  );

  // Strict `=== true` check (not just truthiness) so a third-party/JS
  // Guardrail resolving with a truthy-but-non-boolean `pass` (e.g.
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
