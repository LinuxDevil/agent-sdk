/**
 * N10a: `oidc()`, a `jwt()` whose keys come from the configured issuer's
 * OpenID discovery document. The discovery URL is derived from configuration
 * (never from a token); the document must name exactly the configured issuer,
 * and its `jwks_uri` must be https (http only on localhost).
 * No `node:*` import.
 */
import { SDKError } from '../utils/sdkError';
import { isTrustedKeyUrl } from './encoding';
import {
  bearerJwt,
  checkAlgorithms,
  checkClaimOptions,
  claimsPrincipal,
  fetchJsonDocument,
  KeyDocumentError,
  jwksKeySource,
  KEY_SET_ALGORITHMS,
  KEY_SET_DEFAULT_ALGORITHMS,
  type JwtAlgorithm,
  type JwtClaims,
  type KeySource,
} from './jwt';
import type { AuthFn, Principal } from './types';

export interface OidcOptions {
  /** The issuer, exactly as tokens carry it in `iss` and the discovery document names it. */
  issuer: string;
  /** Accepted `aud` values (your client id or API identifier). */
  audience: string | readonly string[];
  /** Default: `<issuer without trailing slash>/.well-known/openid-configuration`. */
  discoveryUrl?: string;
  /** Default `['RS256', 'ES256']`. HMAC algorithms are not allowed. */
  algorithms?: readonly JwtAlgorithm[];
  /** Clock tolerance in seconds; default 60, at most 300. */
  clockToleranceSec?: number;
  /** Maps verified claims to the principal; `null` skips. Default: `{ id: sub, type: 'user', authenticator: 'oidc', issuer: iss, claims }`. */
  principal?: (claims: JwtClaims) => Principal | null;
  /** For discovery and the key set; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** A failed discovery is retried at most this often. */
const DISCOVERY_RETRY_MS = 30_000;

/** The key source behind discovery: the document is fetched once (cached), a failure is retried at most every 30 s. */
function discoveredKeySource(issuer: string, discoveryUrl: string, fetchImpl: typeof fetch): KeySource {
  let keys: KeySource | undefined;
  let pending: Promise<KeySource | undefined> | undefined;
  let failedAt = -Infinity;
  const discover = async (): Promise<KeySource | undefined> => {
    try {
      const document = await fetchJsonDocument(discoveryUrl, fetchImpl);
      if (document.issuer !== issuer) throw new KeyDocumentError(`the document names issuer '${String(document.issuer)}', not '${issuer}'`);
      const jwksUri = document.jwks_uri;
      if (typeof jwksUri !== 'string' || !isTrustedKeyUrl(jwksUri)) throw new KeyDocumentError("its 'jwks_uri' is missing or not https");
      keys = jwksKeySource(jwksUri, fetchImpl);
      return keys;
    } catch (error) {
      failedAt = Date.now();
      console.warn(`[lousho auth] oidc(): discovery at ${discoveryUrl} failed: ${(error as Error).message}`);
      return undefined;
    }
  };
  return {
    async keys(kid) {
      if (!keys && !pending && Date.now() - failedAt >= DISCOVERY_RETRY_MS) pending = discover().finally(() => (pending = undefined));
      const source = keys ?? (await pending);
      return source ? source.keys(kid) : [];
    },
  };
}

/**
 * Accepts a bearer JWT issued by the OpenID Connect provider `issuer`: keys
 * from its discovery document's `jwks_uri` (cached, refreshed with a bound),
 * `iss` equal to `issuer`, `aud` one of `audience`. Anything else skips.
 *
 * @example
 * ```ts
 * oidc({ issuer: 'https://accounts.google.com', audience: process.env.GOOGLE_CLIENT_ID! })
 * ```
 */
export function oidc(options: OidcOptions): AuthFn {
  const { issuer } = options;
  if (typeof issuer !== 'string' || !isTrustedKeyUrl(issuer)) {
    throw new SDKError("oidc(): 'issuer' must be an https URL (http only on localhost).", 'LOUSHO_AUTH_CONFIG_INVALID');
  }
  const discoveryUrl = options.discoveryUrl ?? `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  if (!isTrustedKeyUrl(discoveryUrl)) {
    throw new SDKError("oidc(): 'discoveryUrl' must be an https URL (http only on localhost).", 'LOUSHO_AUTH_CONFIG_INVALID');
  }
  checkClaimOptions('oidc()', { issuer, audience: options.audience, clockToleranceSec: options.clockToleranceSec });
  const algorithms = checkAlgorithms('oidc()', options.algorithms, KEY_SET_ALGORITHMS);
  return bearerJwt({
    source: discoveredKeySource(issuer, discoveryUrl, options.fetch ?? ((...args) => fetch(...args))),
    checks: {
      algorithms: options.algorithms === undefined ? KEY_SET_DEFAULT_ALGORITHMS : algorithms,
      issuer,
      audience: options.audience,
      ...(options.clockToleranceSec !== undefined && { clockToleranceSec: options.clockToleranceSec }),
    },
    principal: options.principal ?? claimsPrincipal('oidc'),
  });
}
