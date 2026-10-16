/**
 * A failed attempt at a checkpointed run, recorded on its
 * `'in-progress'` checkpoint (`lastError`, `attempts`) so `agent.pending()`
 * can tell a run that keeps failing from one a crash interrupted.
 */

import type { CheckpointError } from './checkpoint';
import type { ExecuteOptions } from './AgentExecutor';
import type { AgentRunState } from './agentRunState';
import { CompactedLLMProviderError, SDKError } from './errors';

/** A session turn's checkpoint key: the session records its turns' failures itself (`AgentSession`). */
const SESSION_TURN_KEY = /\.turn-\d+$/;

/** A resume refused before anything ran: another process runs it (its lease), or its agent changed - the checkpoint stays as it was. */
const NOT_AN_ATTEMPT: ReadonlySet<string> = new Set(['LOUSHO_SESSION_BUSY', 'LOUSHO_AGENT_DRIFT', 'LOUSHO_RESUME_TOOL_MISSING']);

/**
 * What a failed attempt records. Only a provider error known not to go away is
 * not retryable: a context-length or auth failure, or another 4xx response (not 408 / 409 / 429). A crash, a network
 * error, a 5xx or an unclassified failure stays retryable, so the next attempt resumes the run as before.
 */
export function checkpointError(error: unknown): CheckpointError {
  const compacted = error instanceof CompactedLLMProviderError ? error.compacted : undefined;
  const code = error instanceof SDKError ? error.code : undefined;
  const cause = error instanceof Error ? (error.cause as { status?: unknown; statusCode?: unknown } | undefined) : undefined;
  const status = Number(compacted?.statusCode ?? cause?.statusCode ?? cause?.status);
  const clientError = status >= 400 && status < 500 && ![408, 409, 429].includes(status);
  const permanent = compacted !== undefined && !compacted.retryable && (compacted.category === 'context-length-exceeded' || compacted.category === 'auth-failure' || clientError);
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(code && { code }),
    ...(compacted && { category: compacted.category }),
    retryable: !permanent,
    at: new Date().toISOString(),
  };
}

/**
 * When a checkpointed run (`send(msg, { sessionId })`, `agent.resume()`)
 * rejects, stamps `lastError` and `attempts` on its `'in-progress'` checkpoint
 * - under the run's lease, so a run that lost it writes nothing. A run without
 * one (it failed before its first checkpoint) or that ended or paused is left
 * alone, and so is a session turn, which records its own, and a resume refused
 * before anything ran.
 */
export async function recordRunFailure(options: ExecuteOptions, state: AgentRunState, error: unknown): Promise<void> {
  const { sessionId, checkpointStore } = options;
  if (!sessionId || !checkpointStore || SESSION_TURN_KEY.test(sessionId)) return;
  if (error instanceof SDKError && NOT_AN_ATTEMPT.has(error.code)) return;
  await state.saving;
  const checkpoint = await checkpointStore.load(sessionId);
  if (!checkpoint || (checkpoint.status ?? 'in-progress') !== 'in-progress') return;
  const failed = { ...checkpoint, lastError: checkpointError(error), attempts: (checkpoint.attempts ?? 0) + 1 };
  const { lease } = state;
  await (lease?.id === sessionId ? lease.save(failed) : checkpointStore.save(sessionId, failed));
}
