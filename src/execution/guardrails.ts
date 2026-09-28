/**
 * Guardrails
 * Pluggable pre-flight checks run against a proposed agent action (e.g. a
 * diff about to be committed/PR'd) before it's allowed through (LOU-E9+).
 */

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
