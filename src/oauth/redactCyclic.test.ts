/** A tool result `JSON.stringify` cannot serialize (a cycle, a BigInt) still has handed-out tokens redacted. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactHandedOutTokens } from './signIn';

const TOKEN = 'ya29.handed-out-access-token';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('redactHandedOutTokens on a value JSON cannot serialize', () => {
  it('walks a cyclic result: values and keys, arrays and objects, keeping the cycle', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result: Record<string, unknown> = { auth: `Bearer ${TOKEN}`, [TOKEN]: 'as a key', list: [TOKEN, 1, null], size: 10n };
    result.self = result;
    const redacted = redactHandedOutTokens('fetch_inbox', result, new Set([TOKEN])) as Record<string, unknown>;
    expect(redacted.auth).toBe('Bearer [REDACTED]');
    expect(redacted['[REDACTED]']).toBe('as a key');
    expect(redacted[TOKEN]).toBeUndefined();
    expect(redacted.list).toEqual(['[REDACTED]', 1, null]);
    expect(redacted.size).toBe(10n);
    expect(redacted.self).toBe(redacted);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns a cyclic result without the token unchanged', () => {
    const result: Record<string, unknown> = { ok: true, size: 1n };
    result.self = result;
    expect(redactHandedOutTokens('fetch_inbox', result, new Set([TOKEN]))).toBe(result);
  });
});
