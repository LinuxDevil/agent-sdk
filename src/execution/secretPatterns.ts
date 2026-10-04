/**
 * Secret patterns
 * Content patterns that must never appear in a diff or in model-visible
 * text. Node-free: imported by both the patch checks (patchChecks.ts,
 * which pull in node:child_process) and the input/output guardrails
 * (ioGuardrails.ts, which createAgent() reaches), so createAgent() does
 * not reach the patch checks through this list (A5).
 */

/**
 * Patterns for content that must never appear in a diff about to be
 * committed/PR'd. Kept intentionally small and specific (as opposed to a
 * broad secret-detection library) to minimize false positives; extend
 * with more patterns as needed. Also the default patterns of
 * `regexGuardrail()` (LOU-X4).
 */
export const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'private key header', pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
  { label: 'OpenAI-style API key', pattern: /sk-[A-Za-z0-9]{20,}/ },
  { label: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
];
