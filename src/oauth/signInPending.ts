/**
 * N9b: a streamed approval decision that may fail at once with
 * `LOUSHO_SIGNIN_PENDING` (a sign-in pause approved before the user signed
 * in). Surfaces that answer a decision before streaming it (the approvals
 * route answers 409, the chat REPL asks again) read the first event here.
 * Fetch-runtime safe: no `node:*` import.
 */
import type { AgentEvent } from '../execution/agentEvents';

/** The first event told the sign-in is not done yet, or the events (the first one included) to stream. */
export type SignInGate = { pending: true; message: string } | { pending: false; events: AsyncIterable<AgentEvent> };

/** Reads the first event of `events`: a `SignInPendingError` ends it; anything else is replayed with the rest. */
export async function awaitSignInGate(events: AsyncIterable<AgentEvent>): Promise<SignInGate> {
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (!first.done && first.value.type === 'error' && first.value.error.name === 'SignInPendingError') {
    await iterator.return?.();
    return { pending: true, message: first.value.error.message };
  }
  async function* replay(): AsyncGenerator<AgentEvent> {
    for (let next = first; !next.done; next = await iterator.next()) yield next.value;
  }
  return { pending: false, events: replay() };
}
