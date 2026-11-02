/**
 * The shared failure shape every Author tool returns instead of throwing
 * (PLAN §8.3, research §4): `{ ok:false, code, error, userMessage, next? }`
 * where `error` is model-facing and `userMessage` is person-facing.
 * `toolFailure` builds one; `isToolFailure` recognises one in the
 * transcript or a test assertion; `guardedToolCall` is the catch-all that
 * turns a thrown dependency error into `UNAVAILABLE` so a read tool can
 * never crash the turn.
 */
import type { AuthorFailureCode, AuthorToolFailure } from '../../../shared/authorWire';

/**
 * Builds an {@link AuthorToolFailure}: `error` for the model (precisely
 * what went wrong), `userMessage` for the person (plain words), `next`
 * for the model (what to do now), plus any failure-specific detail.
 */
export function toolFailure(
  code: AuthorFailureCode,
  error: string,
  userMessage: string,
  next?: string,
  extra?: Record<string, unknown>
): AuthorToolFailure {
  return { ok: false, code, error, userMessage, ...(next !== undefined && { next }), ...(extra ?? {}) };
}

/**
 * Whether `value` is a tool failure: `ok: false` with the three strings.
 * The code's membership in {@link AuthorFailureCode} is a type-level
 * contract - producers build it via {@link toolFailure}, so a runtime
 * union check would only guard code that bypassed the helper.
 */
// fallow-ignore-next-line unused-export -- part of the P5 tool-failure contract; later tickets (save gate, review tools) consume it
export function isToolFailure(value: unknown): value is AuthorToolFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { ok?: unknown; code?: unknown; error?: unknown; userMessage?: unknown };
  return (
    candidate.ok === false &&
    typeof candidate.code === 'string' &&
    typeof candidate.error === 'string' &&
    typeof candidate.userMessage === 'string'
  );
}

/**
 * Runs a read tool's body: its return value passes through, and any
 * thrown error becomes `UNAVAILABLE` (`<tool> failed: <message>.` for
 * the model, one plain sentence for the person). Wraps every read tool's
 * `execute` so a broken store or a mid-read throw surfaces as a tool
 * result the model can react to instead of a `tool.error` event.
 */
export async function guardedToolCall(toolName: string, run: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return toolFailure(
      'UNAVAILABLE',
      `${toolName} failed: ${error instanceof Error ? error.message : String(error)}.`,
      "Studio couldn't read that just now."
    );
  }
}
