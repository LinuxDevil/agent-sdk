/**
 * Session id validation, in a module with no Node builtins so Worker code
 * (`KVStore`, `@lousho/build-ai-agent/kv`) can import it. `sessionStore.ts`
 * re-exports `assertSessionId`.
 */

import { ConfigurationError } from '../execution/errors';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Throws unless `id` is 1-128 characters of letters, digits, `_` or `-`.
 * Session ids become file names, so anything else (`../`, `/`, `.`) is refused.
 */
export function assertSessionId(id: string): void {
  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
    throw new ConfigurationError(
      `Invalid session id ${JSON.stringify(id)}: use 1-128 characters from A-Z, a-z, 0-9, '_' and '-' ` +
        "(e.g. 'user-42'). Omit the id to get a generated one.",
      'id',
      'LOUSHO_SESSION_ID_INVALID'
    );
  }
}
