/**
 * Guardrails
 * Pluggable pre-flight checks run against a proposed agent action (e.g. a
 * diff about to be committed/PR'd) before it's allowed through (LOU-E9+).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
    return await Promise.race([
      guardrail.check(action).catch(
        (): GuardrailResult => ({
          pass: false,
          reason: `${guardrail.name} threw or timed out`,
        })
      ),
      timeout,
    ]);
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
 * Builds a Guardrail that runs `command args...` in `cwd` and passes iff
 * the process exits 0. Used for both the test-run and lint guardrails
 * below (and reusable for any other "run this command, pass on exit 0"
 * check) so that logic isn't duplicated per guardrail.
 *
 * Deliberately has no timeout of its own - runGuardrailSafely() (LOU-E9)
 * already races every guardrail (including this one) against a timeout,
 * and a second, independent timeout mechanism here would just be
 * redundant complexity. When the outer race gives up first, the
 * underlying child process may keep running in the background; that's an
 * accepted tradeoff of not duplicating the timeout here.
 */
export function createCommandGuardrail(
  name: string,
  cwd: string,
  command: string,
  args: string[]
): Guardrail {
  return {
    name,
    async check(_action: ProposedAction): Promise<GuardrailResult> {
      try {
        // On Windows, npm (and other npm-installed CLIs) are .cmd shims
        // that execFile can only invoke through a shell.
        await execFileAsync(command, args, { cwd, shell: process.platform === 'win32' });
        return { pass: true };
      } catch (error) {
        const err = error as { code?: number | string; stderr?: string; message: string };
        const stderr = (err.stderr || '').toString().trim();
        return {
          pass: false,
          reason: `${name} failed (exit code ${err.code ?? 'unknown'})${
            stderr ? `: ${stderr}` : `: ${err.message}`
          }`,
        };
      }
    },
  };
}

/**
 * Runs `npm test` in `repoPath` and passes iff it exits 0.
 */
export function createTestRunGuardrail(repoPath: string): Guardrail {
  return createCommandGuardrail('test-run', repoPath, 'npm', ['test']);
}

/**
 * Runs `npm run lint` in `repoPath` and passes iff it exits 0.
 */
export function createLintGuardrail(repoPath: string): Guardrail {
  return createCommandGuardrail('lint', repoPath, 'npm', ['run', 'lint']);
}
