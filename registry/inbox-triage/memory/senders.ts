/**
 * Per-sender memory ("remember per-sender facts"): who prefers a terse reply,
 * whose timezone is UTC+2, which alias the billing contact answers to.
 *
 * Scope: a run that acts for a verified sender (the inbound channel sets the
 * principal; callers can also pass `metadata.sender` to send()) gets that
 * sender's own file. Batch runs - the poll schedule, a bare `agent.send` -
 * share the 'shared' scope, so facts there are written per sender inside the
 * text ("priya@acme.com - prefers ...") and visible on every sweep.
 *
 * The provider wraps fileMemory() so `dir` is resolved on each call: the same
 * INBOX_TRIAGE_HOME the mail store uses, under `memory/`.
 */
import path from 'node:path';
import { defineMemory, fileMemory, type MemoryProvider } from '@lousho/build-ai-agent';
import { home } from '../lib/mailstore';

const backing = (): MemoryProvider => fileMemory({ dir: path.join(home(), 'memory') });

const provider: MemoryProvider = {
  list: (scopeKey, options) => backing().list(scopeKey, options),
  add: (scopeKey, item) => backing().add(scopeKey, item),
  remove: (scopeKey, id) => backing().remove(scopeKey, id),
};

export default defineMemory({
  name: 'senders',
  description:
    'Facts about the people who write in: how they like to be addressed, tone, time zone, role, past decisions. In shared-scope runs, start each item with the sender address.',
  scope: (ctx) => {
    const claimed = ctx.principal?.id ?? (typeof ctx.metadata?.sender === 'string' ? ctx.metadata.sender : undefined);
    // issuer and authenticator together name where the id came from (channels set authenticator).
    const via = ctx.principal?.issuer ?? ctx.principal?.authenticator ?? 'inbox';
    return claimed === undefined ? 'shared' : `sender:${via}:${claimed}`;
  },
  provider,
});
