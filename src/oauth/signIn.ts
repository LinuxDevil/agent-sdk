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
export const SIGN_IN_TTL_MS = 10 * 60 * 1000;
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

/**
 * The user credential a sign-in pause of a run acting for `principal` waits on.
 * A principal without an `issuer` is namespaced by its authenticator
 * (`authenticator:<name>`), so the same id from two authenticators (a Slack user
 * and a GitHub login) never shares a token.
 */
export function signInOwner(principal: Readonly<Principal> | undefined): TokenOwner | undefined {
  if (!principal) return undefined;
  const issuer = principal.issuer ?? (principal.authenticator ? `authenticator:${principal.authenticator}` : undefined);
  return { owner: 'user', principalId: principal.id, ...(issuer !== undefined && { issuer }) };
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
  let stored = await tokens.get(provider.name, owner);
  // Eve TOOLS-F16: a failed refresh is retried once when another caller replaced the token meanwhile.
  for (let attempt = 0; stored && attempt < 2; attempt++) {
    const state = usable(stored, Date.now());
    if (state === 'fresh') return handOut(stored, access);
    if (state === 'expired') break;
    const refreshed = await refreshOnce(provider, stored);
    if (refreshed) {
      await tokens.set(provider.name, owner, refreshed);
      return handOut(refreshed, access);
    }
    stored = await tokenAfterFailedRefresh(tokens, provider, owner, stored);
  }
  if (owner.owner === 'app') throw appSignInRequired(provider);
  throw new SignInRequired(provider, owner);
}

/** The token to retry after refreshing `failed` failed: a replacement another caller stored meanwhile, else `undefined`. */
async function tokenAfterFailedRefresh(
  tokens: OAuthTokenStore,
  provider: OAuthProvider,
  owner: TokenOwner,
  failed: OAuthToken
): Promise<OAuthToken | undefined> {
  // Rotating refresh tokens are single use: the failure may only mean a concurrent refresh (in
  // another process) won. Delete the token only when it is still the one that failed.
  const current = await tokens.get(provider.name, owner);
  if (!current || sameToken(current, failed)) {
    if (current) await tokens.delete(provider.name, owner);
    return undefined;
  }
  return current;
}

function sameToken(a: OAuthToken, b: OAuthToken): boolean {
  return a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
}

/**
 * Eve TOOLS-F16: refreshes in flight, by provider and refresh token. Callers
 * that present the same refresh token at once share one request (a rotating
 * refresh token is single use, so a second request would be refused).
 */
const refreshesInFlight = new Map<string, Promise<OAuthToken | undefined>>();

/** One refresh of `stored` per process at a time. `undefined` when it failed. */
function refreshOnce(provider: OAuthProvider, stored: OAuthToken): Promise<OAuthToken | undefined> {
  const key = `${provider.name}\u0000${provider.tokenUrl}\u0000${stored.refreshToken ?? ''}`;
  const pending = refreshesInFlight.get(key);
  if (pending) return pending;
  const flight = refreshToken(provider, stored)
    .catch(() => undefined)
    .finally(() => refreshesInFlight.delete(key));
  refreshesInFlight.set(key, flight);
  return flight;
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
  const mine = signInOwner(principal);
  return mine?.owner !== 'user' || mine.principalId !== owner.principalId || mine.issuer !== owner.issuer;
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
export async function completeSignIn(
  params: OAuthCallbackParams,
  tokens: OAuthTokenStore | undefined,
  mcp?: McpSignInExchange
): Promise<OAuthCompleteResult> {
  if (!tokens) throw storeMissing();
  const pending = await takeOwnPending(params, tokens);
  const mcpServer = pending.data?.mcpServer;
  if (typeof mcpServer === 'string') return completeMcpSignIn(mcpServer, pending, params, mcp);
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

/**
 * N9c: exchanges the code of an MCP server's sign-in (a pending record with
 * `data.mcpServer`) through the MCP SDK and stores the token.
 */
export type McpSignInExchange = (server: string, pending: PendingSignIn, code: string) => Promise<void>;

/** {@link completeSignIn} for an MCP server's pending sign-in (N9c). */
async function completeMcpSignIn(server: string, pending: PendingSignIn, params: OAuthCallbackParams, mcp: McpSignInExchange | undefined): Promise<OAuthCompleteResult> {
  const where = { provider: pending.provider, displayName: server };
  if (params.error !== undefined) return { ...where, outcome: 'declined' };
  if (!mcp) {
    throw new SDKError(`No MCP server named '${server}' with \`oauth\` is configured on this agent.`, 'LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED');
  }
  if (typeof params.code !== 'string' || params.code === '') {
    throw new SDKError(`MCP server '${server}' redirected without an authorization code.`, 'LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED');
  }
  await mcp(server, pending, params.code);
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
/** A token shorter than this is matched only verbatim: its base64 fragments would be too short to mean anything. */
const MIN_ENCODED_SECRET = 8;
/** How deep an error's `cause` chain is followed. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Eve TOOLS-F2: the base64 forms of `secret` wherever it sits inside an
 * encoded value (`Basic base64(user:token)`). For each of the three byte
 * alignments, the characters that encode only the secret's own bytes, in the
 * URL-safe and the standard alphabet.
 */
function encodedForms(secret: string): string[] {
  const bytes = new TextEncoder().encode(secret);
  const forms: string[] = [];
  for (let skip = 0; skip < 3; skip++) {
    const aligned = bytes.subarray(skip, skip + Math.floor((bytes.length - skip) / 3) * 3);
    if (aligned.length < 6) continue;
    const url = base64url(aligned);
    forms.push(url, url.replace(/-/g, '+').replace(/_/g, '/'));
  }
  return forms;
}

/** Every form of the handed-out tokens to look for (verbatim, JSON-escaped, base64), longest first. */
function secretForms(handedOut: ReadonlySet<string>): string[] {
  const forms = new Set<string>();
  for (const secret of handedOut) {
    if (secret.length === 0) continue;
    forms.add(secret);
    forms.add(JSON.stringify(secret).slice(1, -1));
    if (secret.length >= MIN_ENCODED_SECRET) for (const form of encodedForms(secret)) forms.add(form);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function hasSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => text.includes(secret));
}

function scrubText(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => out.split(secret).join(REDACTED), text);
}

/** `text` with the secrets replaced, recording on `hit` whether there were any. */
function scrubString(text: string, secrets: readonly string[], hit: { found: boolean }): string {
  if (!hasSecret(text, secrets)) return text;
  hit.found = true;
  return scrubText(text, secrets);
}

/** For a value `JSON.stringify` cannot serialize (a cycle, a BigInt): strings and keys of arrays and objects. */
function scrubWalk(value: unknown, secrets: readonly string[], seen: WeakMap<object, unknown>, hit: { found: boolean }): unknown {
  if (typeof value === 'string') return scrubString(value, secrets, hit);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(scrubWalk(item, secrets, seen, hit));
    return copy;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[scrubWalk(key, secrets, seen, hit) as string] = scrubWalk(item, secrets, seen, hit);
  return copy;
}

/**
 * `value` with the secrets replaced, judged on its JSON form (what the
 * transcript records): values, keys, a `URL`, a class instance's fields.
 * `undefined` when there is nothing to replace.
 */
function scrubValue(value: unknown, secrets: readonly string[]): { value: unknown } | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    const hit = { found: false };
    const walked = scrubWalk(value, secrets, new WeakMap(), hit);
    return hit.found ? { value: walked } : undefined;
  }
  if (json === undefined || !hasSecret(json, secrets)) return undefined;
  return { value: JSON.parse(scrubText(json, secrets)) as unknown };
}

function warnRedacted(toolName: string, how: string): void {
  console.warn(`[lousho] Tool '${toolName}' ${how} an OAuth token it got from ctx.getToken(); it was replaced with ${REDACTED}. Return the API's answer, not the token.`);
}

/**
 * The safety net behind "never return a token from a tool": a result that
 * contains a token handed out during the call (verbatim, JSON-escaped or
 * base64-encoded, anywhere in its JSON form, keys included) is replaced by
 * its JSON with the token turned into `[REDACTED]`, and a warning names the
 * tool, never the token.
 */
export function redactHandedOutTokens(toolName: string, result: unknown, handedOut: ReadonlySet<string>): unknown {
  const secrets = secretForms(handedOut);
  if (secrets.length === 0) return result;
  const scrubbed = scrubValue(result, secrets);
  if (!scrubbed) return result;
  warnRedacted(toolName, 'returned');
  return scrubbed.value;
}

function setOwn(target: object, key: string, value: unknown): void {
  try {
    const enumerable = Object.prototype.propertyIsEnumerable.call(target, key);
    Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable });
  } catch {
    // A frozen error: redactHandedOutError() throws a copy instead.
  }
}

/**
 * Eve TOOLS-F2: the same safety net for what a tool throws. The `message`,
 * `stack` and `cause` chain of an error (or a thrown string or object) have
 * the handed-out tokens replaced by `[REDACTED]` before the error becomes the
 * call's error result. The error keeps its identity (class, name, code).
 */
export function redactHandedOutError(toolName: string, error: unknown, handedOut: ReadonlySet<string>): unknown {
  const secrets = secretForms(handedOut);
  if (secrets.length === 0) return error;
  let found = false;
  const visit = (value: unknown, depth: number): unknown => {
    if (!(value instanceof Error)) {
      const scrubbed = scrubValue(value, secrets);
      if (scrubbed) found = true;
      return scrubbed ? scrubbed.value : value;
    }
    for (const key of ['message', 'stack'] as const) {
      const text = value[key];
      if (typeof text === 'string' && hasSecret(text, secrets)) {
        found = true;
        setOwn(value, key, scrubText(text, secrets));
      }
    }
    if (value.cause !== undefined && depth < MAX_CAUSE_DEPTH) setOwn(value, 'cause', visit(value.cause, depth + 1));
    return value;
  };
  const result = visit(error, 0);
  if (!found) return error;
  warnRedacted(toolName, 'threw an error containing');
  if (result instanceof Error && hasSecret(`${result.message}\n${result.stack ?? ''}`, secrets)) {
    return new Error(scrubText(result.message, secrets));
  }
  return result;
}
