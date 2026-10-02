/**
 * N10a: `basic()` (HTTP Basic, RFC 7617) and `apiToken()` (one shared bearer
 * token, what `LOUSHO_API_TOKEN` has always been). Both compare in constant
 * time: every side is hashed to one length first, and `basic()` walks every
 * configured user, so an unknown user takes as long as a wrong password.
 * Only use `basic()` over HTTPS. No `node:*` import.
 */
import { SDKError } from '../utils/sdkError';
import { bearerToken, fromBase64, sameDigest, sameSecret, sha256, utf8 } from './encoding';
import type { AuthFn, Principal } from './types';

export interface BasicOptions {
  /** User name to password, or a function that checks a pair (it should compare in constant time itself). */
  users: Readonly<Record<string, string>> | ((user: string, password: string) => boolean | Promise<boolean>);
  /** The realm of the `WWW-Authenticate: Basic` challenge. Default `'lousho'`. */
  realm?: string;
}

/** The NFC-normalized user and password of an `Authorization: Basic` header, or `undefined`. */
function basicCredentials(header: string | null): { user: string; password: string } | undefined {
  const encoded = /^Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(header ?? '')?.[1];
  const bytes = encoded === undefined ? undefined : fromBase64(encoded);
  const decoded = bytes && utf8(bytes);
  const colon = decoded?.indexOf(':') ?? -1;
  if (decoded === undefined || colon < 0) return undefined;
  return { user: decoded.slice(0, colon).normalize('NFC'), password: decoded.slice(colon + 1).normalize('NFC') };
}

type Digests = Array<{ user: Uint8Array; password: Uint8Array; name: string }>;

function usersChecker(users: Readonly<Record<string, string>>): (user: string, password: string) => Promise<string | undefined> {
  const entries = Object.entries(users);
  if (entries.length === 0 || entries.some(([user, password]) => user === '' || user.includes(':') || typeof password !== 'string' || password === '')) {
    throw new SDKError("basic(): 'users' needs at least one user; names must be non-empty without ':', passwords non-empty strings.", 'LOUSHO_AUTH_CONFIG_INVALID');
  }
  let digests: Promise<Digests> | undefined;
  const configured = () =>
    (digests ??= Promise.all(
      entries.map(async ([user, password]) => ({ name: user.normalize('NFC'), user: await sha256(user.normalize('NFC')), password: await sha256(password.normalize('NFC')) }))
    ));
  return async (user, password) => {
    const [all, presentedUser, presentedPassword] = await Promise.all([configured(), sha256(user), sha256(password)]);
    let match: string | undefined;
    // Every entry is compared, with no early exit, whether or not the user exists.
    for (const entry of all) {
      const userOk = sameDigest(entry.user, presentedUser);
      const passwordOk = sameDigest(entry.password, presentedPassword);
      if (userOk && passwordOk) match = entry.name;
    }
    return match;
  };
}

const quoted = (value: string) => `"${value.replace(/[\\"]/g, '\\$&')}"`;

/**
 * Accepts `Authorization: Basic` credentials found in `users` (principal
 * `{ id: <user>, type: 'user', authenticator: 'basic' }`). No Basic header,
 * or wrong credentials, skip to the next entry. Only use over HTTPS.
 *
 * @example
 * ```ts
 * basic({ users: { ops: process.env.OPS_PASSWORD! }, realm: 'agent' })
 * ```
 */
export function basic(options: BasicOptions): AuthFn {
  const check =
    typeof options.users === 'function'
      ? (() => {
          const fn = options.users;
          return async (user: string, password: string) => ((await fn(user, password)) === true ? user : undefined);
        })()
      : usersChecker(options.users);
  const realm = options.realm ?? 'lousho';
  const auth: AuthFn = async (request): Promise<Principal | null> => {
    const credentials = basicCredentials(request.headers.get('authorization'));
    if (!credentials) return null;
    const user = await check(credentials.user, credentials.password);
    return user === undefined ? null : { id: user, type: 'user', authenticator: 'basic' };
  };
  auth.challenges = [{ scheme: 'Basic', realm }];
  return auth;
}

/** The `WWW-Authenticate` value of a Basic challenge. */
export function basicChallenge(realm: string | undefined): string {
  return `Basic realm=${quoted(realm ?? 'lousho')}, charset="UTF-8"`;
}

/**
 * Accepts `Authorization: Bearer <token>` (compared in constant time) as the
 * service principal `{ id: options.id ?? 'api-token', type: 'service', authenticator: 'api-token' }`.
 * This is what `LOUSHO_API_TOKEN` and `createRouteHandler({ auth: '<token>' })` use.
 *
 * @example
 * ```ts
 * apiToken(process.env.AGENT_TOKEN!, { id: 'ci' })
 * ```
 */
export function apiToken(token: string, options: { id?: string } = {}): AuthFn {
  if (typeof token !== 'string' || token === '') throw new SDKError('apiToken(): the token must be a non-empty string.', 'LOUSHO_AUTH_CONFIG_INVALID');
  const principal: Principal = Object.freeze({ id: options.id ?? 'api-token', type: 'service', authenticator: 'api-token' });
  const auth: AuthFn = async (request) => {
    const presented = bearerToken(request.headers.get('authorization'));
    return presented !== undefined && (await sameSecret(presented, token)) ? { ...principal } : null;
  };
  auth.challenges = [{ scheme: 'Bearer' }];
  return auth;
}

/** Accepts every request as `{ id: 'anonymous', type: 'user', authenticator: 'anonymous' }`: explicit open access, e.g. as the last entry. */
export function anonymous(): AuthFn {
  return () => ({ id: 'anonymous', type: 'user', authenticator: 'anonymous' });
}
