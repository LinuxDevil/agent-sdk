/**
 * OAuth token storage types (N9a): the `tokens` part of an `AgentStore`.
 * Nothing here signs in; N9b adds the flow and N9c MCP server OAuth.
 */

/** Who a stored credential belongs to: the agent itself, or one signed-in user. */
export type CredentialOwner = 'app' | 'user';

/** An OAuth access token, with its refresh token when the server gave one. */
export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  /** Usually `'Bearer'`. */
  tokenType?: string;
  /** When the access token expires, in ms since the epoch. */
  expiresAt?: number;
  scope?: string;
}

/**
 * Who a stored credential belongs to. A user credential is keyed by the
 * principal's id and, when it has one, its issuer: route auth's
 * `principal.id` and `principal.issuer` map onto `principalId` and `issuer`.
 */
export type TokenOwner = { owner: 'app' } | { owner: 'user'; principalId: string; issuer?: string };

/** Short-lived sign-in state (PKCE verifier and context), kept between the redirect and the callback. */
export interface PendingSignIn {
  provider: string;
  owner: TokenOwner;
  codeVerifier?: string;
  redirectUri: string;
  approvalId?: string;
  /** ms since the epoch. */
  createdAt: number;
  data?: Record<string, unknown>;
}

/** What {@link OAuthTokenStore.list} returns about a stored token: never the token itself. */
export interface OAuthTokenInfo {
  provider: string;
  owner: TokenOwner;
  tokenType?: string;
  expiresAt?: number;
  scope?: string;
  /** Whether a refresh token is stored (the value is not returned). */
  hasRefreshToken: boolean;
  /** When the token was last written, in ms since the epoch. */
  updatedAt: number;
}

/** Filter of {@link OAuthTokenStore.list}; both parts optional. */
export interface OAuthTokenListOptions {
  provider?: string;
  owner?: TokenOwner;
}

/**
 * Durable OAuth credentials, keyed by provider and owner. The persistent
 * stores (`fileStore`, `SqliteStore`, `KVStore`) encrypt every record with
 * AES-256-GCM under the application's `tokenKey`; `memoryStore()` keeps plain
 * objects in process memory.
 */
export interface OAuthTokenStore {
  get(provider: string, owner: TokenOwner): Promise<OAuthToken | undefined>;
  set(provider: string, owner: TokenOwner, token: OAuthToken): Promise<void>;
  delete(provider: string, owner: TokenOwner): Promise<void>;
  /** Metadata of the stored tokens (no access or refresh token values), optionally for one provider and/or owner. */
  list(options?: OAuthTokenListOptions): Promise<OAuthTokenInfo[]>;
  /** Short-lived sign-in state (PKCE verifier and context), single use: `take` returns and deletes it. */
  putPending(state: string, value: PendingSignIn, ttlMs: number): Promise<void>;
  takePending(state: string): Promise<PendingSignIn | undefined>;
  /** A client registered with an authorization server (dynamic client registration, used by N9c), per provider. */
  getClient(provider: string): Promise<Record<string, unknown> | undefined>;
  setClient(provider: string, client: Record<string, unknown>): Promise<void>;
}
