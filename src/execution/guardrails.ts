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
