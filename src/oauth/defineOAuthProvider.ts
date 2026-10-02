/**
 * N9b: an OAuth 2.0 provider a tool signs in to (`ctx.getToken(provider)`).
 * Plain data plus the provider's `fetch`; the sign-in flow is in signIn.ts.
 *
 * Fetch-runtime safe: no `node:*` import.
 */
import { ConfigurationError } from '../execution/errors';
import type { CredentialOwner } from './types';

/** How a confidential client authenticates at the token endpoint. */
export type OAuthClientAuth = 'client_secret_post' | 'client_secret_basic';

/** Options of {@link defineOAuthProvider}. */
export interface OAuthProviderOptions {
  /** The provider's name, also its token store key: 1-64 characters from `A-Z`, `a-z`, `0-9`, `_` and `-`. */
  name: string;
  /** Shown on the sign-in prompt, e.g. `'GitHub'`. Default: `name`. */
  displayName?: string;
  /**
   * Whose credential the token is. `'user'` (the default): one token per
   * signed-in user, so a run needs a principal. `'app'`: one token the agent
   * uses for everyone, signed in by the operator with `agent.oauth.signInUrl()`.
   */
  credentialOwner?: CredentialOwner;
  /** The authorization endpoint the user is sent to. */
  authorizationUrl: string;
  /** The token endpoint codes and refresh tokens are exchanged at. */
  tokenUrl: string;
  clientId: string;
  /** Omit for a public client (PKCE only). */
  clientSecret?: string;
  /** Default `'client_secret_post'`. */
  clientAuth?: OAuthClientAuth;
  scopes?: readonly string[];
  /**
   * Where the provider redirects after sign-in: the agent's `/oauth/callback`
   * route (e.g. `https://agent.example.com/api/agent/oauth/callback`), exactly
   * as registered with the provider.
   */
  redirectUri: string;
  /** Extra query parameters of the authorization URL (e.g. `{ prompt: 'consent' }`). */
  authorizationParams?: Record<string, string>;
  /** The `fetch` used for the token endpoint (tests inject a fake). Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** A provider made by {@link defineOAuthProvider}: its options, validated and frozen. */
export interface OAuthProvider extends Readonly<Omit<OAuthProviderOptions, 'displayName' | 'credentialOwner' | 'clientAuth' | 'scopes'>> {
  readonly kind: 'oauth-provider';
  readonly displayName: string;
  readonly credentialOwner: CredentialOwner;
  readonly clientAuth: OAuthClientAuth;
  readonly scopes: readonly string[];
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Providers by name, as last defined in this process: `agent.oauth.complete()` finds a sign-in's provider here. */
const providers = new Map<string, OAuthProvider>();

function assertUrl(value: unknown, field: string, name: string): void {
  let url: URL | undefined;
  try {
    url = typeof value === 'string' ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new ConfigurationError(`defineOAuthProvider('${name}'): \`${field}\` must be an absolute http(s) URL.`, field);
  }
}

/**
 * Defines an OAuth 2.0 provider (authorization code with PKCE) for tools that
 * call an API on the user's behalf. A tool asks for a token with
 * `ctx.getToken(provider)`; without one the run pauses until the user signs in.
 * The provider is also registered under its `name` for this process, so the
 * callback route can finish a sign-in that started in another request; define
 * it at module level, next to the tools that use it.
 *
 * @example
 * ```ts
 * import { defineOAuthProvider } from '@lousho/build-ai-agent';
 *
 * export const github = defineOAuthProvider({
 *   name: 'github',
 *   displayName: 'GitHub',
 *   authorizationUrl: 'https://github.com/login/oauth/authorize',
 *   tokenUrl: 'https://github.com/login/oauth/access_token',
 *   clientId: process.env.GITHUB_CLIENT_ID ?? '',
 *   clientSecret: process.env.GITHUB_CLIENT_SECRET,
 *   scopes: ['repo'],
 *   redirectUri: 'https://agent.example.com/oauth/callback',
 * });
 * ```
 */
export function defineOAuthProvider(options: OAuthProviderOptions): OAuthProvider {
  const { name } = options;
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new ConfigurationError('defineOAuthProvider: `name` must be 1-64 characters from A-Z, a-z, 0-9, _ and -.', 'name');
  }
  assertUrl(options.authorizationUrl, 'authorizationUrl', name);
  assertUrl(options.tokenUrl, 'tokenUrl', name);
  assertUrl(options.redirectUri, 'redirectUri', name);
  if (typeof options.clientId !== 'string' || options.clientId === '') {
    throw new ConfigurationError(`defineOAuthProvider('${name}'): \`clientId\` must be a non-empty string.`, 'clientId');
  }
  const owner = options.credentialOwner ?? 'user';
  if (owner !== 'user' && owner !== 'app') {
    throw new ConfigurationError(`defineOAuthProvider('${name}'): \`credentialOwner\` must be 'user' or 'app'.`, 'credentialOwner');
  }
  const clientAuth = options.clientAuth ?? 'client_secret_post';
  if (clientAuth !== 'client_secret_post' && clientAuth !== 'client_secret_basic') {
    throw new ConfigurationError(`defineOAuthProvider('${name}'): \`clientAuth\` must be 'client_secret_post' or 'client_secret_basic'.`, 'clientAuth');
  }
  const provider: OAuthProvider = Object.freeze({
    ...options,
    kind: 'oauth-provider' as const,
    displayName: options.displayName ?? name,
    credentialOwner: owner,
    clientAuth,
    scopes: Object.freeze([...(options.scopes ?? [])]),
    ...(options.authorizationParams && { authorizationParams: Object.freeze({ ...options.authorizationParams }) }),
  });
  providers.set(name, provider);
  return provider;
}

/** The provider defined last under `name` in this process. */
export function registeredOAuthProvider(name: string): OAuthProvider | undefined {
  return providers.get(name);
}

/** Whether `value` is a provider made by {@link defineOAuthProvider}. */
export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'oauth-provider';
}
