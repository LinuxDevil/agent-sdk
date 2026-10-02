/**
 * N9b: OAuth sign-in for tools. `ctx.getToken(provider)` reads the caller's
 * token from `AgentStore.tokens` (refreshing it when it is about to expire);
 * without one it throws {@link SignInRequired}, which the executor turns into
 * a durable `kind: 'sign-in'` pause. {@link startSignIn} builds the
 * authorization URL (PKCE S256, a 256-bit `state`) and keeps the verifier in
 * the encrypted pending record; {@link completeSignIn} exchanges the code at
 * the callback. No token, refresh token, verifier or code ever goes into an
 * error message, an event or a log line.
 *
 * Fetch-runtime safe: no `node:*` import.
 */
import { ConfigurationError, SDKError } from '../execution/errors';
import { markPropagating } from '../execution/propagatingToolError';
import type { Principal } from '../auth/types';
import { isOAuthProvider, registeredOAuthProvider, type OAuthProvider } from './defineOAuthProvider';
import type { OAuthToken, OAuthTokenStore, PendingSignIn, TokenOwner } from './types';
import type { ApprovalSignIn } from '../execution/ApprovalGate';
import { toBase64Url as base64url } from '../utils/base64url';

/** How long a sign-in link (its `state`) works. */
const SIGN_IN_TTL_MS = 10 * 60 * 1000;
/** A token this close to `expiresAt` is refreshed first (when it has a refresh token). */
const REFRESH_MARGIN_MS = 60 * 1000;
const SIGN_IN_REQUIRED = 'LoushoSignInRequired';

/**
 * Thrown by `ctx.getToken()` / `ctx.requireAuth()` when the caller has no
 * usable token. Internal: the executor pauses the run on it (checked by name,
 * since bundling can split class identity), so it never reaches the model.
 */
export class SignInRequired extends Error {
  constructor(
    readonly provider: OAuthProvider,
    readonly owner: TokenOwner,
    /** `requireAuth()`: the stored token is deleted before the run pauses. */
    readonly revoke = false
  ) {
    super(`Sign-in to ${provider.displayName} is required.`);
    this.name = SIGN_IN_REQUIRED;
  }
}

/** Whether `error` is a {@link SignInRequired} (from any loaded copy of the SDK). */
export function isSignInRequired(error: unknown): error is SignInRequired {
  return error instanceof Error && error.name === SIGN_IN_REQUIRED && isOAuthProvider((error as Partial<SignInRequired>).provider);
}

/**
 * `agent.approvals.resolve({ id, approved: true })` on a sign-in pause before
 * the user signed in (`LOUSHO_SIGNIN_PENDING`, HTTP 409 on the approvals
 * route). The pause stays: sign in, then approve again.
 */
export class SignInPendingError extends SDKError {
  constructor(provider: string) {
    super(`The user has not signed in to ${provider} yet, so the paused call cannot run. Open the sign-in link first.`, 'LOUSHO_SIGNIN_PENDING');
    this.name = 'SignInPendingError';
  }
}

/** The user credential a sign-in pause of a run acting for `principal` waits on. */
export function signInOwner(principal: Readonly<Principal> | undefined): TokenOwner | undefined {
  return principal ? { owner: 'user', principalId: principal.id, ...(principal.issuer !== undefined && { issuer: principal.issuer }) } : undefined;
}

/** What `getToken()` / `requireAuth()` need from the run. */
export interface TokenAccess {
  tokens?: OAuthTokenStore;
  principal?: Readonly<Principal>;
  /** Tokens handed to the tool during this call: a result containing one is redacted. */
  handedOut?: Set<string>;
}

function storeMissing(): ConfigurationError {
  const error = new ConfigurationError(
    'This tool needs an OAuth token, but the agent has no token store: pass createAgent({ store }) with `tokens` (memoryStore(), fileStore(), SqliteStore or KVStore).',
    'store',
    'LOUSHO_OAUTH_STORE_MISSING'
  );
  // A configuration mistake stops the run instead of becoming a tool result the model retries.
  markPropagating(error);
  return error;
}

function assertProvider(provider: unknown): asserts provider is OAuthProvider {
  if (!isOAuthProvider(provider)) {
    throw new ConfigurationError('getToken() / requireAuth() take a provider made by defineOAuthProvider().', 'provider');
  }
}

/** The owner of `provider`'s credential for a run acting for `principal`. */
function tokenOwnerFor(provider: OAuthProvider, principal: Readonly<Principal> | undefined): TokenOwner {
  if (provider.credentialOwner === 'app') return { owner: 'app' };
  const owner = signInOwner(principal);
  if (!owner) {
    throw new SDKError(
      `Sign-in to ${provider.displayName} needs to know who the user is, and this run has no principal: a '${provider.name}' credential is kept per user.`,
      'LOUSHO_OAUTH_PRINCIPAL_REQUIRED'
    );
  }
  return owner;
}

/** The error a tool gets when the app's own credential is missing: the operator signs the app in, a chat user never does. */
function appSignInRequired(provider: OAuthProvider): SDKError {
  return new SDKError(
    `The app is not signed in to ${provider.displayName}. The operator signs it in once with agent.oauth.signInUrl(); a chat user cannot.`,
    'LOUSHO_OAUTH_APP_SIGNIN_REQUIRED'
  );
}

function usable(token: OAuthToken, now: number): 'fresh' | 'refresh' | 'expired' {
  if (token.expiresAt === undefined || token.expiresAt - now > REFRESH_MARGIN_MS) return 'fresh';
  if (token.refreshToken) return 'refresh';
  return token.expiresAt > now ? 'fresh' : 'expired';
}

function handOut(token: OAuthToken, access: TokenAccess): OAuthToken {
  access.handedOut?.add(token.accessToken);
  if (token.refreshToken) access.handedOut?.add(token.refreshToken);
  return Object.freeze({ ...token });
}

/**
 * `ctx.getToken(provider)`: the caller's (or the app's) token, refreshed when
 * it expires within 60 s. Throws {@link SignInRequired} when there is none
 * (or the refresh failed), `LOUSHO_OAUTH_PRINCIPAL_REQUIRED` for a user
 * credential on a run without a principal, `LOUSHO_OAUTH_APP_SIGNIN_REQUIRED`
 * for a missing app credential and `LOUSHO_OAUTH_STORE_MISSING` without a store.
 */
export async function getToken(provider: OAuthProvider, access: TokenAccess): Promise<OAuthToken> {
  assertProvider(provider);
  const { tokens } = access;
  if (!tokens) throw storeMissing();
  const owner = tokenOwnerFor(provider, access.principal);
  const stored = await tokens.get(provider.name, owner);
  const state = stored ? usable(stored, Date.now()) : 'expired';
  if (stored && state === 'fresh') return handOut(stored, access);
  if (stored && state === 'refresh') {
    const refreshed = await refreshToken(provider, stored).catch(() => undefined);
    if (refreshed) {
      await tokens.set(provider.name, owner, refreshed);
      return handOut(refreshed, access);
    }
    await tokens.delete(provider.name, owner);
  }
  if (owner.owner === 'app') throw appSignInRequired(provider);
  throw new SignInRequired(provider, owner);
}

/**
 * `ctx.requireAuth(provider)`: the token was refused downstream (a 401), so
 * it is deleted and the run pauses for a new sign-in (an app credential: the
 * call fails with `LOUSHO_OAUTH_APP_SIGNIN_REQUIRED`).
 */
export function requireAuth(provider: OAuthProvider, access: TokenAccess): never {
  assertProvider(provider);
  if (!access.tokens) throw storeMissing();
  throw new SignInRequired(provider, tokenOwnerFor(provider, access.principal), true);
}

/**
 * What a {@link SignInRequired} thrown by a tool means for the call: after a
 * `requireAuth()` the stored token is deleted; an app credential is an error
 * for the call, a user credential a pause.
 */
export async function settleSignInRequired(signal: SignInRequired, tokens: OAuthTokenStore | undefined): Promise<{ error: SDKError } | { pause: SignInRequired }> {
  if (signal.revoke) await tokens?.delete(signal.provider.name, signal.owner);
  return signal.owner.owner === 'app' ? { error: appSignInRequired(signal.provider) } : { pause: signal };
}

function randomToken(): string {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

async function codeChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** Where a sign-in returns to: the approval it continues and the session it paused in. */
export interface SignInContext {
  approvalId?: string;
  sessionId?: string;
}

/**
 * Starts a sign-in to `provider` for `owner`: a PKCE S256 verifier (32 random
 * bytes) and a 256-bit `state`, kept for 10 minutes as a single-use pending
 * record in the encrypted store. Resolves with the authorization URL (it
 * holds the `state` and the challenge, never the verifier).
 */
export async function startSignIn(provider: OAuthProvider, owner: TokenOwner, tokens: OAuthTokenStore | undefined, context: SignInContext = {}): Promise<string> {
  if (!tokens) throw storeMissing();
  const codeVerifier = randomToken();
  const state = randomToken();
  const url = new URL(provider.authorizationUrl);
  for (const [key, value] of Object.entries(provider.authorizationParams ?? {})) url.searchParams.set(key, value);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', provider.redirectUri);
  if (provider.scopes.length > 0) url.searchParams.set('scope', provider.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await codeChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  const pending: PendingSignIn = {
    provider: provider.name,
    owner,
    codeVerifier,
    redirectUri: provider.redirectUri,
    createdAt: Date.now(),
    ...(context.approvalId !== undefined && { approvalId: context.approvalId }),
    ...(context.sessionId !== undefined && { data: { sessionId: context.sessionId } }),
  };
  await tokens.putPending(state, pending, SIGN_IN_TTL_MS);
  return url.toString();
}

/** The `signIn` of a `kind: 'sign-in'` pause: starts the sign-in {@link SignInRequired} asks for. */
export async function signInRequest(signal: SignInRequired, tokens: OAuthTokenStore | undefined, context: SignInContext): Promise<ApprovalSignIn> {
  const url = await startSignIn(signal.provider, signal.owner, tokens, context);
  return { provider: signal.provider.name, displayName: signal.provider.displayName, url };
}

/** What the provider's redirect to the callback carries (its query parameters). */
export interface OAuthCallbackParams {
  state: string;
  code?: string;
  /** The provider's `error` (e.g. `access_denied` when the user declined). */
  error?: string;
  /**
   * Who is completing the sign-in, when the callback request was
   * authenticated. A user's sign-in is refused (`LOUSHO_OAUTH_STATE_INVALID`)
   * when it belongs to another user.
   */
  principal?: Principal;
}

/** How {@link completeSignIn} ended. */
export interface OAuthCompleteResult {
  /** The paused run's approval; absent for an operator's app sign-in. */
  approvalId?: string;
  sessionId?: string;
  outcome: 'signed-in' | 'declined';
  /** The provider's `name`. */
  provider: string;
  /** The provider's `displayName`, when it is defined in this process. */
  displayName?: string;
}

function stateInvalid(why: string): SDKError {
  return new SDKError(`This sign-in link ${why}.`, 'LOUSHO_OAUTH_STATE_INVALID');
}

function isOtherUser(owner: TokenOwner, principal: Principal | undefined): boolean {
  if (!principal || owner.owner !== 'user') return false;
  return principal.id !== owner.principalId || (principal.issuer ?? undefined) !== (owner.issuer ?? undefined);
}

/**
 * The pending sign-in for `params.state`, taken once; one made for another
 * user than an authenticated `params.principal` is put back and refused.
 */
async function takeOwnPending(params: OAuthCallbackParams, tokens: OAuthTokenStore): Promise<PendingSignIn> {
  const state = typeof params.state === 'string' ? params.state : '';
  const pending = state ? await tokens.takePending(state) : undefined;
  if (!pending) throw stateInvalid('is unknown, was already used, or expired');
  if (!isOtherUser(pending.owner, params.principal)) return pending;
  // Put it back for its own user, for what is left of its 10 minutes.
  const left = pending.createdAt + SIGN_IN_TTL_MS - Date.now();
  if (left > 0) await tokens.putPending(state, pending, left);
  throw stateInvalid('was made for another user');
}

/** Which sign-in a callback finished: its provider and, for a paused run, its approval and session. */
function whereOf(pending: PendingSignIn, provider: OAuthProvider | undefined): Omit<OAuthCompleteResult, 'outcome'> {
  const sessionId = pending.data?.sessionId;
  return {
    provider: pending.provider,
    ...(provider && { displayName: provider.displayName }),
    ...(pending.approvalId !== undefined && { approvalId: pending.approvalId }),
    ...(typeof sessionId === 'string' && { sessionId }),
  };
}

/**
 * The callback's work: takes the pending sign-in for `state` (once; unknown or
 * expired is `LOUSHO_OAUTH_STATE_INVALID`), exchanges `code` with its PKCE
 * verifier at the provider's `tokenUrl` and stores the token for the owner the
 * sign-in was started for. A provider `error` ends it as `'declined'`. It does
 * not continue the paused run.
 */
export async function completeSignIn(params: OAuthCallbackParams, tokens: OAuthTokenStore | undefined): Promise<OAuthCompleteResult> {
  if (!tokens) throw storeMissing();
  const pending = await takeOwnPending(params, tokens);
  const provider = registeredOAuthProvider(pending.provider);
  const where = whereOf(pending, provider);
  if (params.error !== undefined) return { ...where, outcome: 'declined' };
  if (!provider) {
    throw new SDKError(`No OAuth provider named '${pending.provider}' is defined in this process (defineOAuthProvider()).`, 'LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED');
  }
  if (typeof params.code !== 'string' || params.code === '') {
    throw new SDKError(`${provider.displayName} redirected without an authorization code.`, 'LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED');
  }
  const token = await tokenRequest(provider, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: pending.redirectUri,
    ...(pending.codeVerifier !== undefined && { code_verifier: pending.codeVerifier }),
  });
  await tokens.set(provider.name, pending.owner, token);
  return { ...where, outcome: 'signed-in' };
}

/** A refreshed token (the old refresh token is kept when the server sends no new one). */
async function refreshToken(provider: OAuthProvider, token: OAuthToken): Promise<OAuthToken> {
  const refreshed = await tokenRequest(provider, {
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken ?? '',
    ...(provider.scopes.length > 0 && { scope: provider.scopes.join(' ') }),
  });
  return { ...refreshed, refreshToken: refreshed.refreshToken ?? token.refreshToken };
}

function exchangeFailed(provider: OAuthProvider, why: string): SDKError {
  return new SDKError(`The ${provider.displayName} token endpoint refused the request: ${why}.`, 'LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED');
}

/** The provider's `error` field, only when it is a plain OAuth error code (never echo anything else). */
function errorCode(body: Record<string, unknown>): string | undefined {
  return typeof body.error === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(body.error) ? body.error : undefined;
}

/** The token request's form and headers, with the provider's client authentication. */
function tokenRequestInit(provider: OAuthProvider, params: Record<string, string>): RequestInit {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const secret = provider.clientSecret;
  if (secret !== undefined && provider.clientAuth === 'client_secret_basic') {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(provider.clientId)}:${encodeURIComponent(secret)}`)}`;
  } else {
    body.set('client_id', provider.clientId);
    if (secret !== undefined) body.set('client_secret', secret);
  }
  return { method: 'POST', headers, body: body.toString() };
}

/** POSTs a form to the provider's token endpoint with its client authentication and reads the token. */
async function tokenRequest(provider: OAuthProvider, params: Record<string, string>): Promise<OAuthToken> {
  const doFetch = provider.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let res: Response;
  try {
    res = await doFetch(provider.tokenUrl, tokenRequestInit(provider, params));
  } catch {
    throw exchangeFailed(provider, 'the request failed');
  }
  const json = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const code = errorCode(json);
  if (!res.ok || code !== undefined || typeof json.access_token !== 'string' || json.access_token === '') {
    throw exchangeFailed(provider, `HTTP ${res.status}${code ? ` (${code})` : ''}`);
  }
  return tokenOf(json, json.access_token);
}

/** The token in a token endpoint's JSON answer. */
function tokenOf(json: Record<string, unknown>, accessToken: string): OAuthToken {
  const expiresIn = Number(json.expires_in);
  return {
    accessToken,
    ...(typeof json.refresh_token === 'string' && json.refresh_token !== '' && { refreshToken: json.refresh_token }),
    ...(typeof json.token_type === 'string' && { tokenType: json.token_type }),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 && { expiresAt: Date.now() + expiresIn * 1000 }),
    ...(typeof json.scope === 'string' && { scope: json.scope }),
  };
}

const REDACTED = '[REDACTED]';

function scrub(value: unknown, secrets: readonly string[], seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join(REDACTED), value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(scrub(item, secrets, seen));
    return copy;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = scrub(item, secrets, seen);
  return copy;
}

function contains(value: unknown, secrets: readonly string[], seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return secrets.some((secret) => value.includes(secret));
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  const proto: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).some((item) => contains(item, secrets, seen));
}

/**
 * The safety net behind "never return a token from a tool": a result that
 * contains a token handed out during the call has it replaced by
 * `[REDACTED]` (strings, arrays and plain objects; other objects are left as
 * they are), and a warning names the tool, never the token.
 */
export function redactHandedOutTokens(toolName: string, result: unknown, handedOut: ReadonlySet<string>): unknown {
  const secrets = [...handedOut].filter((secret) => secret.length > 0);
  if (secrets.length === 0 || !contains(result, secrets)) return result;
  console.warn(`[lousho] Tool '${toolName}' returned an OAuth token it got from ctx.getToken(); it was replaced with ${REDACTED}. Return the API's answer, not the token.`);
  return scrub(result, secrets, new WeakMap());
}
