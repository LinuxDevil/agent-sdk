import { describe, it, expect } from 'vitest';
import { isSecretRef, secretRefSchema } from './secrets';

describe('secretRefSchema', () => {
  it('accepts { env } and { secret } refs', () => {
    expect(secretRefSchema.safeParse({ env: 'GITHUB_TOKEN' }).success).toBe(true);
    expect(secretRefSchema.safeParse({ secret: 'github-token' }).success).toBe(true);
  });

  it('rejects bad names, extra keys, unknown keys and non-objects', () => {
    const rejected: unknown[] = [
      { env: '1X' },
      { secret: '' },
      { env: 'A', secret: 'b' },
      { value: 'x' },
      'GITHUB_TOKEN',
    ];
    for (const value of rejected) {
      expect(secretRefSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('isSecretRef', () => {
  it('is shape only: one key env/secret with a string value is a ref, whatever the name', () => {
    expect(isSecretRef({ env: 'GITHUB_TOKEN' })).toBe(true);
    expect(isSecretRef({ secret: 'github-token' })).toBe(true);
    // Shape, not name validity — { env: '1X' } and { secret: '' } still look like refs.
    expect(isSecretRef({ env: '1X' })).toBe(true);
    expect(isSecretRef({ secret: '' })).toBe(true);
  });

  it('is false for extra keys, unknown keys and non-objects', () => {
    expect(isSecretRef({ env: 'A', secret: 'b' })).toBe(false);
    expect(isSecretRef({ value: 'x' })).toBe(false);
    expect(isSecretRef('GITHUB_TOKEN')).toBe(false);
    expect(isSecretRef(42)).toBe(false);
    expect(isSecretRef(null)).toBe(false);
  });
});
