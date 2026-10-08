/** Eve TOOLS-F15: the token owner is namespaced by the authenticator when a principal has no issuer. */
import { describe, expect, it } from 'vitest';
import type { Principal } from '../auth/types';
import { signInOwner } from './signIn';

const slack: Principal = { id: 'U04ABCDEF', type: 'user', authenticator: 'slack' };
const github: Principal = { id: 'U04ABCDEF', type: 'user', authenticator: 'github' };

describe('signInOwner (TOOLS-F15)', () => {
  it('defaults the issuer to authenticator:<name>, so one id from two authenticators is two owners', () => {
    expect(signInOwner(slack)).toEqual({ owner: 'user', principalId: 'U04ABCDEF', issuer: 'authenticator:slack' });
    expect(signInOwner(github)).toEqual({ owner: 'user', principalId: 'U04ABCDEF', issuer: 'authenticator:github' });
  });

  it('keeps an explicit issuer as is', () => {
    expect(signInOwner({ ...github, authenticator: 'jwt', issuer: 'https://id.example.com' })).toEqual({ owner: 'user', principalId: 'U04ABCDEF', issuer: 'https://id.example.com' });
  });

  it('has no owner without a principal', () => {
    expect(signInOwner(undefined)).toBeUndefined();
  });
});
