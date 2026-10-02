/**
 * N10b: the run's principal (N10a, docs/auth.md) as tools, approval policies,
 * permission rules and sub-agents see it. One run has one principal: fixed
 * when it starts, stored with its checkpoints and approval snapshots, and kept
 * on resume whoever resumes it. A caller that decides an approval is the
 * approver (`ctx.approval.by`), never the run's principal.
 *
 * Fetch-runtime safe: no `node:*` import.
 */

import type { Principal } from '../auth/types';
import { ConfigurationError } from './errors';

/** Principals {@link readonlyPrincipal} already returned (so a run freezes its principal once). */
const frozen = new WeakSet<object>();

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A frozen copy of plain objects and arrays, all the way down; other values are kept as they are. */
function frozenCopy(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (!isPlainObject(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = frozenCopy(entry);
  return Object.freeze(copy);
}

/**
 * A deep-frozen copy of `principal` (the same object when it is one already),
 * so a tool, a policy or a hook cannot change who the run acts for. A tool
 * that assigns to it throws in strict mode (every ES module is strict).
 */
export function readonlyPrincipal(principal: Principal | undefined): Readonly<Principal> | undefined {
  if (principal === undefined) return undefined;
  if (frozen.has(principal)) return principal;
  const copy = frozenCopy(principal) as Readonly<Principal>;
  frozen.add(copy);
  return copy;
}

/** Whether `a` and `b` are the same caller: same `id`, `type`, `authenticator` and `issuer`. */
function samePrincipal(a: Principal, b: Principal): boolean {
  return a.id === b.id && a.type === b.type && a.authenticator === b.authenticator && a.issuer === b.issuer;
}

/**
 * The principal of a run continued from its unfinished checkpoint: the one it
 * was saved with (`undefined` for a run that had none, or a checkpoint written
 * before N10b). A call that passes no principal (`agent.resume()`, a
 * session's pending turn) continues as that caller; a call that passes a
 * different one is refused, so its input never runs under another caller's
 * identity (`LOUSHO_CONFIG_INVALID`).
 */
export function resumedRunPrincipal(saved: Principal | undefined, call: Principal | undefined, sessionId: string): Principal | undefined {
  if (call === undefined || (saved !== undefined && samePrincipal(saved, call))) return saved;
  throw new ConfigurationError(
    `The unfinished run '${sessionId}' was started by another caller, so it cannot continue with this call's principal. ` +
      'Resume it without a principal (agent.resume()), or start a new session.',
    'principal'
  );
}
