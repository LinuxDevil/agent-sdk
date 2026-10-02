/**
 * N10a: who is calling. A `Principal` is the caller a route's auth list
 * accepted; it rides into the run (`send()` / `stream()` / session turns, the
 * `model` / `instructions` / `tools` functions and memory scopes).
 *
 * Fetch-runtime safe: no `node:*` import (bundled into Workers and edge routes).
 */

/** The caller a route accepted (or a channel identified). */
export interface Principal {
  /** Stable subject: a JWT `sub`, a Basic user name, a Slack user id, ... */
  id: string;
  type: 'user' | 'service';
  /** Which helper accepted it: `'jwt'`, `'oidc'`, `'basic'`, `'api-token'`, `'anonymous'`, `'slack'`, ... or a custom name. */
  authenticator: string;
  /** The JWT `iss`. Part of the identity: the same `id` from another issuer is another caller. */
  issuer?: string;
  /** Verified claims (JWT) or custom attributes. Never the raw token or a password. */
  claims?: Readonly<Record<string, unknown>>;
}

/** A challenge a helper answers a 401 with, as a `WWW-Authenticate` header. */
export interface AuthChallenge {
  scheme: 'Bearer' | 'Basic';
  realm?: string;
}

/** What one auth entry decides: a `Principal` accepts, `null` / `undefined` skips to the next entry. */
export type AuthResult = Principal | null | undefined;

/**
 * One entry of a route's auth list: accept (return a `Principal`), skip to the
 * next entry (return `null` / `undefined`), or reject the request outright
 * (throw `AuthError`). `challenges` are what a 401 advertises; a function
 * without them advertises `Bearer`.
 */
export type AuthFn = ((request: Request) => AuthResult | Promise<AuthResult>) & { challenges?: readonly AuthChallenge[] };

/** Thrown by an auth entry to reject the request: the list stops with this status. The message is logged by nobody and never sent. */
export class AuthError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message?: string) {
    super(message ?? (status === 401 ? 'Unauthorized' : 'Forbidden'));
    this.name = 'AuthError';
    this.status = status;
  }
}
