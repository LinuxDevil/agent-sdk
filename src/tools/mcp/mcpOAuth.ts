/**
 * N9c: OAuth for HTTP MCP servers, per the MCP authorization spec. The MCP
 * SDK does the protocol (RFC 9728 and RFC 8414 discovery, RFC 7591 dynamic
 * registration, PKCE, RFC 8707 resource indicators, refresh); this module is
 * its `OAuthClientProvider` over the agent's encrypted token store, and the
 * operator's sign-in on top of N9b's pending records and callback.
 *
 * The grant belongs to the app (provider `mcp-<server>`, owner `app`). A
 * connection never starts an interactive sign-in: without a usable token the
 * server's status becomes `'needs-auth'` and the call fails with
 * `LOUSHO_MCP_AUTH_REQUIRED`. No token, code, verifier or client secret goes
 * into an error message, a log line or `status()`.
 */
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ConfigurationError, SDKError } from '../../execution/errors';
import { loadOptionalPeer } from '../../providers/optionalPeer';
import { SIGN_IN_TTL_MS } from '../../oauth/signIn';
import type { OAuthTokenStore, PendingSignIn } from '../../oauth/types';
import type { McpHttpServerSpec, McpOAuthOptions, McpServerSpec } from '../../spec/schema';
import { toBase64Url } from '../../utils/base64url';

const PEER = '@modelcontextprotocol/sdk';
const APP = { owner: 'app' } as const;
const NEEDS_SIGN_IN = 'LoushoMcpNeedsSignIn';
const AUTH_REQUIRED = 'LOUSHO_MCP_AUTH_REQUIRED';

/** An HTTP MCP server entry with `oauth`. */
export type McpOAuthServerSpec = McpHttpServerSpec & { oauth: McpOAuthOptions };

/** Whether `server` is an HTTP entry with `oauth`. */
export function hasMcpOAuth(server: McpServerSpec | undefined): server is McpOAuthServerSpec {
  return server !== undefined && 'url' in server && server.oauth !== undefined;
}

/** The token store's provider name of an MCP server's grant. */
function providerName(server: string): string {
  return `mcp-${server}`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Refuses `oauth` on a plain-http `url` (other than loopback), and an
 * `Authorization` header next to `oauth` (it would replace the bearer token).
 */
export function assertMcpOAuth(name: string, server: McpOAuthServerSpec): void {
  const url = new URL(server.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new ConfigurationError(
      `MCP server '${name}': \`oauth\` needs an https url (http is allowed only for localhost, 127.0.0.1 and [::1]).`,
      'mcpServers'
    );
  }
  if (Object.keys(server.headers ?? {}).some((header) => header.toLowerCase() === 'authorization')) {
    throw new ConfigurationError(
      `MCP server '${name}': remove the Authorization header; with \`oauth\` the SDK sends the bearer token itself.`,
      'mcpServers'
    );
  }
}

/** `LOUSHO_OAUTH_STORE_MISSING` for an MCP server with `oauth`. */
export function mcpStoreMissing(name: string): ConfigurationError {
  return new ConfigurationError(
    `MCP server '${name}' signs in with OAuth, but there is no token store: pass createAgent({ store }) with \`tokens\` (memoryStore(), fileStore(), SqliteStore or KVStore), or connectMcp(servers, { tokens }).`,
    'store',
    'LOUSHO_OAUTH_STORE_MISSING'
  );
}

/** `LOUSHO_MCP_AUTH_REQUIRED`: the server wants a sign-in the app does not have (never the authorization URL). */
export function mcpAuthRequired(name: string, why?: string): SDKError {
  return new SDKError(
    `MCP server '${name}' needs an OAuth sign-in${why ? ` (${why})` : ''}. The operator signs the app in once with the URL from agent.oauth.mcpSignInUrl('${name}').`,
    AUTH_REQUIRED
  );
}

/** The OAuth `error` code of an MCP SDK `OAuthError`, only when it is a plain code. */
function oauthErrorCode(error: unknown): string | undefined {
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
}

/**
 * Whether `error` means "this server wants a sign-in": the provider refused
 * to start one during a connection, the SDK's `UnauthorizedError`, a 401
 * from the transport, an OAuth error from the token endpoint, or our own
 * `LOUSHO_MCP_AUTH_REQUIRED`.
 */
export async function isMcpAuthError(error: unknown): Promise<boolean> {
  if (!(error instanceof Error)) return false;
  if (error.name === NEEDS_SIGN_IN || (error as { code?: unknown }).code === AUTH_REQUIRED) return true;
  if ((error as { code?: unknown }).code === 401 || oauthErrorCode(error) !== undefined) return true;
  const { UnauthorizedError } = await loadOptionalPeer(PEER, () => import('@modelcontextprotocol/sdk/client/auth.js'));
  return error instanceof UnauthorizedError;
}

/** Why a sign-in failed, without anything the servers sent back except a plain OAuth error code. */
function describe(error: unknown): string {
  const code = oauthErrorCode(error);
  if (code) return `the authorization server answered '${code}'`;
  const message = error instanceof Error ? error.message : String(error);
  // The SDK appends a non-OAuth error body verbatim; never echo it.
  return message.split(/ Raw body:|\n/)[0].slice(0, 200);
}

/**
 * The transport's `fetch`: the entry's `headers` go to the MCP server's own
 * origin only, never to an authorization server elsewhere.
 */
export function mcpFetch(server: McpHttpServerSpec): FetchLike {
  const origin = new URL(server.url).origin;
  const extra = Object.entries(server.headers ?? {});
  return (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.href);
    if (extra.length === 0 || url.origin !== origin) return fetch(input, init);
    const headers = new Headers(init?.headers);
    for (const [key, value] of extra) if (!headers.has(key)) headers.set(key, value);
    return fetch(input, { ...init, headers });
  };
}

/**
 * Which URL a stored grant was made for. A token is only ever sent to the
 * `url` it was obtained for: after the entry's `url` changes, the old grant
 * (and a dynamically registered client) is ignored and the server needs a
 * new sign-in.
 */
interface McpClientRecord {
  serverUrl: string;
  client?: OAuthClientInformationMixed;
}

/** A sign-in in progress (`mcpSignInUrl()` or the callback), as opposed to a connection. */
interface SignInFlow {
  /** The callback: the verifier from the pending record. */
  codeVerifier?: string;
  state?: string;
  authorizationUrl?: URL;
}

/**
 * The MCP SDK's `OAuthClientProvider` over an {@link OAuthTokenStore}, for one
 * server (provider `mcp-<server>`, owner `app`). A connection's provider (no
 * `flow`) never starts an interactive sign-in: where the SDK would, it
 * throws, and the connection reports `needs-auth`. A sign-in's provider
 * ignores the stored token, so the operator always gets a fresh link.
 */
export function storeOAuthProvider(server: string, spec: McpOAuthServerSpec, store: OAuthTokenStore, flow?: SignInFlow): OAuthClientProvider {
  const name = providerName(server);
  const { oauth } = spec;
  const needsSignIn = (): Error => {
    const error = new Error(`MCP server '${server}' is not signed in.`);
    error.name = NEEDS_SIGN_IN;
    return error;
  };
  /** The stored record, when it was made for the configured `url`. */
  const record = async (): Promise<McpClientRecord | undefined> => {
    const stored = (await store.getClient(name)) as McpClientRecord | undefined;
    return stored?.serverUrl === spec.url ? stored : undefined;
  };
  const bind = (client?: OAuthClientInformationMixed) => store.setClient(name, { serverUrl: spec.url, ...(client && { client }) } satisfies McpClientRecord);
  return {
    redirectUrl: oauth.redirectUri,
    clientMetadata: {
      client_name: oauth.clientName ?? 'lousho',
      redirect_uris: [oauth.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: oauth.clientSecret !== undefined ? 'client_secret_post' : 'none',
      ...(oauth.scopes && oauth.scopes.length > 0 && { scope: oauth.scopes.join(' ') }),
    },
    state() {
      if (!flow) throw needsSignIn();
      flow.state = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
      return flow.state;
    },
    async clientInformation() {
      if (oauth.clientId !== undefined) return { client_id: oauth.clientId, ...(oauth.clientSecret !== undefined && { client_secret: oauth.clientSecret }) };
      const client = (await record())?.client;
      // A connection does not register a client: that is part of signing in.
      if (!client && !flow) throw needsSignIn();
      return client;
    },
    saveClientInformation: (client) => bind(client),
    async tokens(): Promise<OAuthTokens | undefined> {
      if (flow || !(await record())) return undefined;
      const token = await store.get(name, APP);
      if (!token) return undefined;
      return {
        access_token: token.accessToken,
        token_type: token.tokenType ?? 'Bearer',
        ...(token.refreshToken !== undefined && { refresh_token: token.refreshToken }),
        ...(token.expiresAt !== undefined && { expires_in: Math.max(0, Math.floor((token.expiresAt - Date.now()) / 1000)) }),
        ...(token.scope !== undefined && { scope: token.scope }),
      };
    },
    async saveTokens(tokens) {
      await store.set(name, APP, {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token !== undefined && { refreshToken: tokens.refresh_token }),
        tokenType: tokens.token_type,
        ...(tokens.expires_in !== undefined && { expiresAt: Date.now() + tokens.expires_in * 1000 }),
        ...(tokens.scope !== undefined && { scope: tokens.scope }),
      });
      // Bind the grant to this url (a pre-registered client has no record yet).
      if (!(await record())) await bind();
    },
    redirectToAuthorization(authorizationUrl) {
      if (!flow) throw needsSignIn();
      flow.authorizationUrl = authorizationUrl;
    },
    async saveCodeVerifier(codeVerifier) {
      if (!flow?.state) throw needsSignIn();
      const pending: PendingSignIn = {
        provider: name,
        owner: APP,
        codeVerifier,
        redirectUri: oauth.redirectUri,
        createdAt: Date.now(),
        data: { mcpServer: server, serverUrl: spec.url },
      };
      await store.putPending(flow.state, pending, SIGN_IN_TTL_MS);
    },
    codeVerifier() {
      if (!flow?.codeVerifier) throw needsSignIn();
      return flow.codeVerifier;
    },
    async invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'tokens') await store.delete(name, APP);
      if ((scope === 'all' || scope === 'client') && oauth.clientId === undefined) await bind();
    },
  };
}

async function loadAuth() {
  return (await loadOptionalPeer(PEER, () => import('@modelcontextprotocol/sdk/client/auth.js'))).auth;
}

/**
 * `agent.oauth.mcpSignInUrl(name)`: runs the SDK's discovery (and dynamic
 * registration when there is no client), keeps the PKCE verifier in a pending
 * record under the URL's `state`, and returns the authorization URL.
 */
export async function startMcpSignIn(name: string, spec: McpOAuthServerSpec, store: OAuthTokenStore): Promise<string> {
  const flow: SignInFlow = {};
  const auth = await loadAuth();
  let result: string;
  try {
    result = await auth(storeOAuthProvider(name, spec, store, flow), { serverUrl: spec.url, fetchFn: mcpFetch(spec) });
  } catch (error) {
    throw new SDKError(`The sign-in to MCP server '${name}' could not start: ${describe(error)}.`, 'LOUSHO_GENERIC_ERROR');
  }
  if (result !== 'REDIRECT' || !flow.authorizationUrl) {
    throw new SDKError(`MCP server '${name}' gave no authorization URL to sign in with.`, 'LOUSHO_GENERIC_ERROR');
  }
  return flow.authorizationUrl.toString();
}

/**
 * The callback's exchange for an MCP server: the SDK trades `code` and the
 * pending record's verifier for tokens at the discovered token endpoint, and
 * the provider stores them. Errors carry the OAuth error code, never the
 * response body.
 */
export async function completeMcpSignIn(
  name: string,
  spec: McpOAuthServerSpec,
  store: OAuthTokenStore,
  pending: PendingSignIn,
  code: string
): Promise<void> {
  if (pending.data?.serverUrl !== spec.url) {
    throw new SDKError(`This sign-in link was made for another url of MCP server '${name}'.`, 'LOUSHO_OAUTH_STATE_INVALID');
  }
  const auth = await loadAuth();
  const flow: SignInFlow = { ...(pending.codeVerifier !== undefined && { codeVerifier: pending.codeVerifier }) };
  try {
    await auth(storeOAuthProvider(name, spec, store, flow), { serverUrl: spec.url, authorizationCode: code, fetchFn: mcpFetch(spec) });
  } catch (error) {
    throw new SDKError(`The token endpoint of MCP server '${name}' refused the sign-in: ${describe(error)}.`, 'LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED');
  }
}
