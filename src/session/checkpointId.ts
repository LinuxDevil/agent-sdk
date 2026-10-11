/**
 * Checkpoint and run id validation, shared by every checkpoint store
 * (memory, file, SQLite, KV) and by `agent.send(msg, { sessionId })`, so an id
 * that works on one backend works on all of them. No Node builtins: Worker code
 * (`KVStore`) imports it.
 */

import { ConfigurationError } from '../execution/errors';

/**
 * A checkpoint id is a run id or a session id plus the suffixes the SDK appends
 * (`.turn-<n>`, `.paused`, `.fork-<n>`): letters, digits, `_`, `-` and `.`, at
 * most 200 characters, not starting with `.` (no `.`, `..` or hidden files) and
 * not ending with `.` (Windows drops a trailing dot). Never a path separator,
 * `#` (the KV store's history keys) or anything outside ASCII.
 */
const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9_-](?:[A-Za-z0-9_.-]{0,198}[A-Za-z0-9_-])?$/;

/**
 * The checkpoint keys of a session (`<id>.turn-<n>`, its turns, and
 * `<id>.paused`, its paused-turn pointer). A run id given by a caller may not
 * end with one of these, or `agent.send(msg, { sessionId: 'victim.turn-2' })`
 * would write into another session's turn.
 */
const SESSION_KEY_SUFFIX = /\.(?:turn-\d+|paused)$/;

/** Schedule fire claims (`schedule-<name>-<fire time>.fire`) share the run lease ids: a run id may not end like one. */
const FIRE_CLAIM_SUFFIX = /\.fire$/;

/** Whether `id` is a valid checkpoint id (see {@link assertCheckpointId}). */
export function isCheckpointId(id: unknown): id is string {
  return typeof id === 'string' && CHECKPOINT_ID_PATTERN.test(id);
}

/** Throws `LOUSHO_SESSION_ID_INVALID` unless `id` is a valid checkpoint id: 1-200 characters of `A-Za-z0-9_.-`, not starting or ending with `.`. */
export function assertCheckpointId(id: unknown, what = 'session id'): asserts id is string {
  if (isCheckpointId(id)) return;
  throw new ConfigurationError(
    `Invalid ${what} ${JSON.stringify(id)}: use 1-200 characters from A-Z, a-z, 0-9, '_', '-' and '.', ` +
      "not starting or ending with '.' (e.g. 'order-42').",
    'sessionId',
    'LOUSHO_SESSION_ID_INVALID'
  );
}

/**
 * {@link assertCheckpointId} for an id a caller names a run by (`agent.send()` /
 * `agent.stream()`'s `sessionId`, a fork's `newSessionId`): it also may not end
 * with a session's own checkpoint keys (`.turn-<n>`, `.paused`), nor with
 * `.fire` (a schedule's fire claim, which a run's lease could otherwise hold).
 */
export function assertRunId(id: unknown, what = 'sessionId'): asserts id is string {
  assertCheckpointId(id, what);
  if (FIRE_CLAIM_SUFFIX.test(id)) {
    throw new ConfigurationError(
      `Invalid ${what} ${JSON.stringify(id)}: ids ending in '.fire' are reserved for schedule fire claims. Pick a run id without that ending.`,
      'sessionId',
      'LOUSHO_SESSION_ID_INVALID'
    );
  }
  if (!SESSION_KEY_SUFFIX.test(id)) return;
  throw new ConfigurationError(
    `Invalid ${what} ${JSON.stringify(id)}: ids ending in '.turn-<n>' or '.paused' are a session's own checkpoint keys. ` +
      'Use agent.session({ id }) for a session, or pick a run id without that ending.',
    'sessionId',
    'LOUSHO_SESSION_ID_INVALID'
  );
}
