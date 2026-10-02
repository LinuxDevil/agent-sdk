/**
 * Record keys of the OAuth token store (N9a). Every component is validated or
 * percent-encoded, so a key is stable, injective and free of the `|`
 * separator inside a component: `a|b` as a principal id cannot collide with
 * another owner.
 */
import { ConfigurationError } from '../execution/errors';
import type { OAuthTokenListOptions, PendingSignIn, TokenOwner } from './types';

/** Provider names follow tool-name rules. */
const PROVIDER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Sign-in state values: a URL-safe random string (base64url of 16+ random bytes). */
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_OWNER_PART = 1024;

/** Throws a `ConfigurationError` unless `provider` matches `^[A-Za-z0-9_-]{1,64}$`. */
function assertProvider(provider: string): void {
  if (typeof provider !== 'string' || !PROVIDER_PATTERN.test(provider)) {
    throw new ConfigurationError(
      `Invalid OAuth provider name ${JSON.stringify(provider)}: use 1-64 characters from A-Z, a-z, 0-9, '_' and '-'.`,
      'provider'
    );
  }
}

function ownerPart(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_OWNER_PART) {
    throw new ConfigurationError(`Invalid token owner: ${what} must be a non-empty string of at most ${MAX_OWNER_PART} characters.`, what);
  }
  return encodeURIComponent(value);
}

/** The owner part of a record key: `app`, or `user|<issuer>|<principalId>` percent-encoded (an absent issuer is empty). */
function ownerKey(owner: TokenOwner): string {
  if (owner?.owner === 'app') return 'app';
  if (owner?.owner === 'user') {
    const issuer = owner.issuer === undefined ? '' : ownerPart(owner.issuer, 'issuer');
    return `user|${issuer}|${ownerPart(owner.principalId, 'principalId')}`;
  }
  throw new ConfigurationError(`Invalid token owner: pass { owner: 'app' } or { owner: 'user', principalId }.`, 'owner');
}

/**
 * The stable, injective key of a token record: `<provider>|app`, or
 * `<provider>|user|<issuer>|<principalId>` with each owner component
 * percent-encoded (an absent issuer is the empty component).
 *
 * @example
 * ```ts
 * tokenStoreKey('github', { owner: 'user', principalId: 'u-1', issuer: 'https://id.example.com' });
 * // 'github|user|https%3A%2F%2Fid.example.com|u-1'
 * ```
 */
export function tokenStoreKey(provider: string, owner: TokenOwner): string {
  assertProvider(provider);
  return `${provider}|${ownerKey(owner)}`;
}

/** The key of a provider's registered client, in the same key space as its tokens. */
export function clientKey(provider: string): string {
  assertProvider(provider);
  return `${provider}|client`;
}

/** The owner a token key names; `undefined` for a client key or a key that is not a token key. */
export function ownerFromKey(key: string): { provider: string; owner: TokenOwner } | undefined {
  const parts = key.split('|');
  if (!PROVIDER_PATTERN.test(parts[0])) return undefined;
  try {
    if (parts.length === 2 && parts[1] === 'app') return { provider: parts[0], owner: { owner: 'app' } };
    if (parts.length === 4 && parts[1] === 'user' && parts[3] !== '') {
      const principalId = decodeURIComponent(parts[3]);
      const owner: TokenOwner = parts[2] === '' ? { owner: 'user', principalId } : { owner: 'user', principalId, issuer: decodeURIComponent(parts[2]) };
      return { provider: parts[0], owner };
    }
  } catch {
    return undefined; // malformed percent-encoding: not a key this module wrote
  }
  return undefined;
}

/** The key prefix that selects `options`' token records: the exact key, a provider's keys, or every key (`''`). */
export function listPrefix(options: OAuthTokenListOptions = {}): { prefix: string; exact: boolean } {
  if (options.provider !== undefined && options.owner !== undefined) return { prefix: tokenStoreKey(options.provider, options.owner), exact: true };
  if (options.provider !== undefined) {
    assertProvider(options.provider);
    return { prefix: `${options.provider}|`, exact: false };
  }
  return { prefix: '', exact: false };
}

/** Whether `key` is a token record `options` selects. */
export function matchesList(key: string, options: OAuthTokenListOptions = {}): boolean {
  const parsed = ownerFromKey(key);
  if (!parsed) return false;
  if (options.provider !== undefined && parsed.provider !== options.provider) return false;
  if (options.owner !== undefined && key.slice(parsed.provider.length + 1) !== ownerKey(options.owner)) return false;
  return true;
}

/** Throws a `ConfigurationError` unless `state` is 16-128 URL-safe characters. */
function assertState(state: string): void {
  if (!isValidState(state)) {
    throw new ConfigurationError('Invalid sign-in state: use 16-128 characters from A-Z, a-z, 0-9, \'_\' and \'-\' (e.g. base64url of 16 random bytes).', 'state');
  }
}

/** Whether `state` has the shape {@link assertState} accepts. */
export function isValidState(state: unknown): state is string {
  return typeof state === 'string' && STATE_PATTERN.test(state);
}

/** Throws a `ConfigurationError` unless `ttlMs` is a positive, finite number of milliseconds. */
function assertTtl(ttlMs: number): void {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new ConfigurationError(`Invalid pending sign-in ttlMs ${String(ttlMs)}: use a positive number of milliseconds.`, 'ttlMs');
  }
}

/** Throws a `ConfigurationError` unless `token` has a non-empty `accessToken` string. Never puts a value in the message. */
export function assertToken(token: unknown): void {
  const accessToken = (token as { accessToken?: unknown } | null)?.accessToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new ConfigurationError('Invalid OAuth token: accessToken must be a non-empty string.', 'accessToken');
  }
}

/** Validate the arguments of `putPending`: the state, the ttl, and the sign-in's provider and owner. */
export function assertPendingInput(state: string, value: PendingSignIn, ttlMs: number): void {
  assertState(state);
  assertTtl(ttlMs);
  tokenStoreKey(value?.provider, value?.owner);
}
