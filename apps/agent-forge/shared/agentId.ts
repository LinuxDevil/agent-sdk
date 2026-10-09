/**
 * The agent id rule, shared by the server (every `:id` becomes a filesystem
 * path segment - see server/types.ts) and the browser client (the "+ New
 * agent" form validates against the same rule inline - Eve DUI-F3).
 */
const AGENT_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;

export function isValidAgentId(id: string): boolean {
  return typeof id === 'string' && AGENT_ID_RE.test(id) && !id.includes('..');
}

/** Why `id` is not a valid agent id, or undefined when it is. */
export function agentIdProblem(id: string): string | undefined {
  if (!id) return 'Enter a name.';
  if (isValidAgentId(id)) return undefined;
  if (id.length > 128) return 'Use at most 128 characters.';
  if (!/^[A-Za-z0-9]/.test(id)) return 'Start with a letter or digit.';
  if (id.includes('..')) return "Don't use '..'.";
  return 'Use only letters, digits, dots, dashes and underscores (no spaces).';
}
