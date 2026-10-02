/**
 * N10a: JWT verification on Web Crypto (`crypto.subtle`) only, so it runs in
 * Node, Workers and edge routes alike. No `node:*` import, no dependency.
 *
 * Rules (each has a test in jwt.test.ts):
 * - `alg: none`, an `alg` outside the configured `algorithms`, and a `crit` header are rejected.
 * - One `jwt()` has exactly one key source, and every algorithm must belong to
 *   that key's family: a token's header can never turn an RSA / EC public key
 *   into an HMAC secret (algorithm confusion). Keys from a key set are never HMAC keys.
 * - Key-set URLs come from the configuration (or OIDC discovery of the configured
 *   issuer), never from the token (`jku`, `x5u`, `jwk` headers are ignored).
 * - `exp` is required; `nbf` and `iat` are honored; `iss` and `aud` are checked
 *   when configured; all with a small bounded clock tolerance (default 60 s, at most 300 s).
 * - A failed check only ever becomes a generic 401: the reason stays inside
 *   this module (tests read it from `JwtVerificationError.reason`).
 */
import { SDKError } from '../utils/sdkError';
import { bearerToken, buffer, fromBase64, fromBase64Url, isTrustedKeyUrl, utf8 } from './encoding';
import type { AuthFn, Principal } from './types';

export type JwtAlgorithm = 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384';

/** A verified token's payload. */
export interface JwtClaims {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  [claim: string]: unknown;
}

type Family = 'HS' | 'RS' | 'ES';
type KeyType = 'oct' | 'RSA' | 'EC';

const ALGORITHMS: Record<JwtAlgorithm, { family: Family; hash: string; curve?: string; signatureBytes?: number }> = {
  HS256: { family: 'HS', hash: 'SHA-256' },
  HS384: { family: 'HS', hash: 'SHA-384' },
  HS512: { family: 'HS', hash: 'SHA-512' },
  RS256: { family: 'RS', hash: 'SHA-256' },
  RS384: { family: 'RS', hash: 'SHA-384' },
  RS512: { family: 'RS', hash: 'SHA-512' },
  ES256: { family: 'ES', hash: 'SHA-256', curve: 'P-256', signatureBytes: 64 },
  ES384: { family: 'ES', hash: 'SHA-384', curve: 'P-384', signatureBytes: 96 },
};

const KEY_TYPE: Record<Family, KeyType> = { HS: 'oct', RS: 'RSA', ES: 'EC' };

/** Longest token accepted (bytes): bounds parsing and hashing work per request. */
const MAX_TOKEN_LENGTH = 16 * 1024;
/** Default and upper bound of `clockToleranceSec`. */
const DEFAULT_CLOCK_TOLERANCE_SEC = 60;
const MAX_CLOCK_TOLERANCE_SEC = 300;
/** Shortest HMAC secret accepted (bytes of UTF-8). */
const MIN_SECRET_BYTES = 32;
/** Most keys one token is tried against. */
const MAX_CANDIDATE_KEYS = 5;
/** Smallest RSA modulus accepted (bits). */
const MIN_RSA_BITS = 2048;

/** Why a token was refused. Internal: a route only ever answers a generic 401. */
export type JwtRejection =
  | 'malformed'
  | 'alg-none'
  | 'alg-not-allowed'
  | 'crit'
  | 'no-key'
  | 'bad-signature'
  | 'missing-exp'
  | 'expired'
  | 'not-yet-valid'
  | 'issued-in-future'
  | 'wrong-issuer'
  | 'wrong-audience';

export class JwtVerificationError extends Error {
  constructor(readonly reason: JwtRejection) {
    super(`JWT rejected: ${reason}`);
    this.name = 'JwtVerificationError';
  }
}

/** A verification key: its JWK metadata and how to import it for one algorithm. */
export interface VerifyKey {
  kid?: string;
  kty: KeyType;
  crv?: string;
  /** The JWK's own `alg`, when it names one: then only that algorithm may use the key. */
  alg?: string;
  importFor(alg: JwtAlgorithm): Promise<CryptoKey>;
}

/** Where verification keys come from: one configured key, or a key set (JWKS). */
export interface KeySource {
  /** Candidate keys for a token whose header names `kid` (or none). */
  keys(kid: string | undefined): Promise<readonly VerifyKey[]>;
}

/** What `verifyJwt` checks beyond the signature. */
export interface JwtChecks {
  algorithms: readonly JwtAlgorithm[];
  issuer?: string | readonly string[];
  audience?: string | readonly string[];
  clockToleranceSec?: number;
  /** Milliseconds since the epoch; defaults to `Date.now()`. */
  now?: () => number;
}

const configError = (message: string): SDKError => new SDKError(message, 'LOUSHO_AUTH_CONFIG_INVALID');

const isAlgorithm = (value: unknown): value is JwtAlgorithm => typeof value === 'string' && Object.hasOwn(ALGORITHMS, value);

const list = <T>(value: T | readonly T[] | undefined): readonly T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value as T]);

function parseJson(segment: string): Record<string, unknown> | undefined {
  const bytes = fromBase64Url(segment);
  const text = bytes && utf8(bytes);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A key that `alg` may use: matching type and curve, and the JWK's own `alg` if it has one. */
function fits(key: VerifyKey, alg: JwtAlgorithm): boolean {
  const spec = ALGORITHMS[alg];
  return key.kty === KEY_TYPE[spec.family] && (spec.curve === undefined || key.crv === spec.curve) && (key.alg === undefined || key.alg === alg);
}

async function verifySignature(key: CryptoKey, alg: JwtAlgorithm, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const spec = ALGORITHMS[alg];
  if (spec.signatureBytes !== undefined && signature.length !== spec.signatureBytes) return false;
  const algorithm = spec.family === 'HS' ? 'HMAC' : spec.family === 'RS' ? 'RSASSA-PKCS1-v1_5' : { name: 'ECDSA', hash: spec.hash };
  return crypto.subtle.verify(algorithm, key, buffer(signature), buffer(data));
}

function checkClaims(claims: JwtClaims, checks: JwtChecks): void {
  const tolerance = checks.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;
  const now = (checks.now?.() ?? Date.now()) / 1000;
  const numeric = (name: 'exp' | 'nbf' | 'iat'): number | undefined => {
    const value = claims[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new JwtVerificationError('malformed');
    return value;
  };
  const exp = numeric('exp');
  const nbf = numeric('nbf');
  const iat = numeric('iat');
  if (exp === undefined) throw new JwtVerificationError('missing-exp');
  if (now >= exp + tolerance) throw new JwtVerificationError('expired');
  if (nbf !== undefined && now < nbf - tolerance) throw new JwtVerificationError('not-yet-valid');
  if (iat !== undefined && now < iat - tolerance) throw new JwtVerificationError('issued-in-future');
  const issuers = list(checks.issuer);
  if (issuers.length > 0 && !(typeof claims.iss === 'string' && issuers.includes(claims.iss))) throw new JwtVerificationError('wrong-issuer');
  const audiences = list(checks.audience);
  if (audiences.length > 0) {
    const presented = list(claims.aud as string | string[] | undefined);
    if (!presented.some((aud) => typeof aud === 'string' && audiences.includes(aud))) throw new JwtVerificationError('wrong-audience');
  }
}

/**
 * Verifies a compact JWS `token` against `source` and `checks`, and returns its
 * claims. Throws `JwtVerificationError` (with the internal `reason`) for any
 * token that must be refused. Reused by N11c.
 */
export async function verifyJwt(token: string, source: KeySource, checks: JwtChecks): Promise<JwtClaims> {
  if (token.length > MAX_TOKEN_LENGTH) throw new JwtVerificationError('malformed');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) throw new JwtVerificationError('malformed');
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = parseJson(headerPart);
  const payload = parseJson(payloadPart);
  const signature = fromBase64Url(signaturePart);
  if (!header || !payload || !signature) throw new JwtVerificationError('malformed');
  const { alg } = header;
  if (typeof alg !== 'string') throw new JwtVerificationError('malformed');
  if (alg.toLowerCase() === 'none') throw new JwtVerificationError('alg-none');
  if (!isAlgorithm(alg) || !checks.algorithms.includes(alg)) throw new JwtVerificationError('alg-not-allowed');
  // No JWS extension is understood, so a token that marks one critical is refused (RFC 7515 4.1.11).
  if (header.crit !== undefined) throw new JwtVerificationError('crit');
  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  // A token without a `kid` is tried against a bounded number of keys, so one request cannot cost a key set's worth of verifications.
  const candidates = (await source.keys(kid)).filter((key) => fits(key, alg)).slice(0, MAX_CANDIDATE_KEYS);
  if (candidates.length === 0) throw new JwtVerificationError('no-key');
  const data = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  let verified = false;
  for (const key of candidates) {
    // A key that cannot be imported (bad key material, an RSA key under 2048 bits) is not a candidate.
    const cryptoKey = await key.importFor(alg).catch(() => undefined);
    if (cryptoKey && (await verifySignature(cryptoKey, alg, signature, data))) {
      verified = true;
      break;
    }
  }
  if (!verified) throw new JwtVerificationError('bad-signature');
  checkClaims(payload, checks);
  return payload;
}

// ---- keys -------------------------------------------------------------------

/** Imports once per algorithm (an imported CryptoKey is bound to its hash). */
function importer(load: (alg: JwtAlgorithm) => Promise<CryptoKey>): (alg: JwtAlgorithm) => Promise<CryptoKey> {
  const cache = new Map<JwtAlgorithm, Promise<CryptoKey>>();
  return (alg) => {
    let key = cache.get(alg);
    if (!key) {
      key = load(alg);
      cache.set(alg, key);
      key.catch(() => cache.delete(alg));
    }
    return key;
  };
}

function importParams(alg: JwtAlgorithm): RsaHashedImportParams | EcKeyImportParams | HmacImportParams {
  const spec = ALGORITHMS[alg];
  if (spec.family === 'HS') return { name: 'HMAC', hash: spec.hash };
  if (spec.family === 'RS') return { name: 'RSASSA-PKCS1-v1_5', hash: spec.hash };
  return { name: 'ECDSA', namedCurve: spec.curve as string };
}

async function checkedKey(key: Promise<CryptoKey>): Promise<CryptoKey> {
  const imported = await key;
  const bits = (imported.algorithm as Partial<RsaHashedKeyAlgorithm>).modulusLength;
  if (bits !== undefined && bits < MIN_RSA_BITS) throw new JwtVerificationError('no-key');
  return imported;
}

/** The HMAC key source of `jwt({ secret })`. */
function secretKeySource(secret: string): KeySource {
  const bytes = new TextEncoder().encode(secret);
  const key: VerifyKey = {
    kty: 'oct',
    importFor: importer((alg) => crypto.subtle.importKey('raw', buffer(bytes), importParams(alg), false, ['verify'])),
  };
  return { keys: async () => [key] };
}

/** The public members of an RSA / EC JWK (a private `d` and other fields are dropped). */
function publicJwk(jwk: JsonWebKey): JsonWebKey | undefined {
  if (jwk.kty === 'RSA' && typeof jwk.n === 'string' && typeof jwk.e === 'string') return { kty: 'RSA', n: jwk.n, e: jwk.e };
  if (jwk.kty === 'EC' && (jwk.crv === 'P-256' || jwk.crv === 'P-384') && typeof jwk.x === 'string' && typeof jwk.y === 'string') {
    return { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y };
  }
  return undefined;
}

function jwkKey(jwk: JsonWebKey & { kid?: unknown; alg?: unknown }): VerifyKey | undefined {
  const pub = publicJwk(jwk);
  if (!pub) return undefined;
  return {
    ...(typeof jwk.kid === 'string' && { kid: jwk.kid }),
    kty: pub.kty as KeyType,
    ...(pub.crv !== undefined && { crv: pub.crv }),
    ...(typeof jwk.alg === 'string' && { alg: jwk.alg }),
    importFor: importer((alg) => checkedKey(crypto.subtle.importKey('jwk', pub, importParams(alg), false, ['verify']))),
  };
}

const RSA_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const EC_OID = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const P256_OID = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const P384_OID = [0x2b, 0x81, 0x04, 0x00, 0x22];

function contains(bytes: Uint8Array, needle: readonly number[]): boolean {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** A PEM `PUBLIC KEY` (SPKI): its key type is read from the algorithm OID, so the algorithms can be checked at construction. */
function pemKey(pem: string): VerifyKey {
  const match = /^-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----$/.exec(pem.trim());
  const der = match && fromBase64(match[1].replace(/\s+/g, ''));
  if (!der) throw configError("jwt(): 'publicKey' must be a PEM public key ('-----BEGIN PUBLIC KEY-----', SPKI) or a JWK. Certificates and private keys are not accepted.");
  const kty: KeyType | undefined = contains(der, RSA_OID) ? 'RSA' : contains(der, EC_OID) ? 'EC' : undefined;
  const crv = kty === 'EC' ? (contains(der, P256_OID) ? 'P-256' : contains(der, P384_OID) ? 'P-384' : undefined) : undefined;
  if (!kty || (kty === 'EC' && !crv)) throw configError("jwt(): 'publicKey' must be an RSA, P-256 or P-384 public key.");
  return {
    kty,
    ...(crv && { crv }),
    importFor: importer((alg) => checkedKey(crypto.subtle.importKey('spki', buffer(der), importParams(alg), false, ['verify']))),
  };
}

function publicKeySource(publicKey: string | JsonWebKey): { source: KeySource; key: VerifyKey } {
  const key = typeof publicKey === 'string' ? pemKey(publicKey) : jwkKey(publicKey);
  if (!key) {
    throw configError("jwt(): 'publicKey' must be an RSA or EC (P-256, P-384) public key. For an HMAC secret use 'secret'.");
  }
  return { source: { keys: async () => [key] }, key };
}

/** Key sets are cached this long, then refetched. */
const JWKS_TTL_MS = 10 * 60_000;
/** At most one fetch per this interval (an unknown `kid` or a failed fetch cannot make every request refetch). */
const JWKS_MIN_REFETCH_MS = 30_000;
/** A cached key set stays usable this long after its last successful fetch while refetches fail. */
const JWKS_MAX_STALE_MS = 60 * 60_000;
/** Fetch timeout, response size cap and key count cap. */
const FETCH_TIMEOUT_MS = 5_000;
const MAX_DOCUMENT_CHARS = 256 * 1024;
const MAX_KEYS = 100;

/** Why a key set or discovery document was unusable; caught and logged as a warning, never sent to a caller. */
export class KeyDocumentError extends Error {}

/** GETs a JSON document from a configured URL, with a timeout and a size cap. */
export async function fetchJsonDocument(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new KeyDocumentError(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') ?? 0) > MAX_DOCUMENT_CHARS) throw new KeyDocumentError('document too large');
  const text = await response.text();
  if (text.length > MAX_DOCUMENT_CHARS) throw new KeyDocumentError('document too large');
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KeyDocumentError('not a JSON object');
  return value as Record<string, unknown>;
}

/** The signing keys of a JWKS document: RSA and EC only (a key set never supplies an HMAC secret), `use: sig`, `key_ops` with `verify`. */
function jwksKeys(document: Record<string, unknown>): VerifyKey[] {
  if (!Array.isArray(document.keys)) throw new KeyDocumentError("no 'keys' array");
  return (document.keys as unknown[]).slice(0, MAX_KEYS).flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const jwk = entry as JsonWebKey & { kid?: unknown; use?: unknown };
    if (jwk.use !== undefined && jwk.use !== 'sig') return [];
    if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify'))) return [];
    const key = jwkKey(jwk);
    return key ? [key] : [];
  });
}

/**
 * A JWKS endpoint as a key source: fetched with `fetchImpl` (5 s timeout),
 * cached for 10 minutes, refetched at most once per 30 seconds when a token
 * names an unknown `kid`. The URL is configuration; nothing in a token can
 * change it. Reused by N11c.
 */
export function jwksKeySource(url: string, fetchImpl: typeof fetch = (...args) => fetch(...args), now: () => number = () => Date.now()): KeySource {
  let keys: VerifyKey[] | undefined;
  let fetchedAt = -Infinity;
  let attemptedAt = -Infinity;
  let inflight: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    inflight ??= (async () => {
      attemptedAt = now();
      try {
        keys = jwksKeys(await fetchJsonDocument(url, fetchImpl));
        fetchedAt = now();
      } catch (error) {
        console.warn(`[lousho auth] could not fetch the key set ${url}: ${(error as Error).message}`);
        if (now() - fetchedAt > JWKS_MAX_STALE_MS) keys = undefined;
      }
    })().finally(() => (inflight = undefined));
    return inflight;
  };
  const mayRefetch = () => now() - attemptedAt >= JWKS_MIN_REFETCH_MS;

  return {
    async keys(kid) {
      if (inflight) await inflight;
      if ((keys === undefined || now() - fetchedAt >= JWKS_TTL_MS) && mayRefetch()) await refresh();
      const matching = () => (kid === undefined ? (keys ?? []) : (keys ?? []).filter((key) => key.kid === kid));
      if (kid !== undefined && matching().length === 0 && mayRefetch()) await refresh();
      return matching();
    },
  };
}

// ---- jwt() -----------------------------------------------------------------

export interface JwtOptions {
  /** HMAC secret (HS256 / HS384 / HS512), at least 32 bytes. */
  secret?: string;
  /** PEM public key (`-----BEGIN PUBLIC KEY-----`) or JWK: RS256 / RS384 / RS512 for RSA, ES256 for P-256, ES384 for P-384. */
  publicKey?: string | JsonWebKey;
  /** A JWKS endpoint (https, or http on localhost) serving RSA / EC keys. */
  jwksUrl?: string;
  /** Allowed algorithms; default: every algorithm of the key's family (`RS256`, `ES256` for `jwksUrl`). */
  algorithms?: readonly JwtAlgorithm[];
  /** Accepted `iss` values (exact match). */
  issuer?: string | readonly string[];
  /** Accepted `aud` values. Required unless `allowAnyAudience: true`. */
  audience?: string | readonly string[];
  allowAnyAudience?: boolean;
  /** Clock tolerance for `exp`, `nbf` and `iat`, in seconds. Default 60, at most 300. */
  clockToleranceSec?: number;
  /** Maps verified claims to the principal; `null` skips. Default: `{ id: sub, type: 'user', authenticator: 'jwt', issuer: iss, claims }`. */
  principal?: (claims: JwtClaims) => Principal | null;
  /** For the key set; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** What `jwt()` and `oidc()` share once their options are checked. */
interface BearerJwtSetup {
  source: KeySource;
  checks: JwtChecks;
  principal: (claims: JwtClaims) => Principal | null;
}

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The default principal of a verified token: its `sub`, or a skip when it has none. */
export function claimsPrincipal(authenticator: string): (claims: JwtClaims) => Principal | null {
  return (claims) =>
    typeof claims.sub === 'string' && claims.sub !== ''
      ? { id: claims.sub, type: 'user', authenticator, ...(typeof claims.iss === 'string' && { issuer: claims.iss }), claims: Object.freeze({ ...claims }) }
      : null;
}

/** An auth entry that verifies the request's bearer JWT; any failed check skips (the list ends in a generic 401). */
export function bearerJwt(setup: BearerJwtSetup): AuthFn {
  const auth: AuthFn = async (request) => {
    const token = bearerToken(request.headers.get('authorization'));
    if (token === undefined || !JWT_SHAPE.test(token)) return null;
    let claims: JwtClaims;
    try {
      claims = await verifyJwt(token, setup.source, setup.checks);
    } catch (error) {
      if (error instanceof JwtVerificationError) return null;
      throw error;
    }
    return setup.principal(claims);
  };
  auth.challenges = [{ scheme: 'Bearer' }];
  return auth;
}

/** Checks `algorithms` (known, not empty, all usable with `kty` / `crv`) and returns them, or the default for the key. */
export function checkAlgorithms(helper: string, algorithms: readonly unknown[] | undefined, allowed: readonly JwtAlgorithm[]): readonly JwtAlgorithm[] {
  if (algorithms === undefined) return allowed;
  if (!Array.isArray(algorithms) || algorithms.length === 0) throw configError(`${helper}: 'algorithms' must be a non-empty list.`);
  for (const alg of algorithms) {
    if (!isAlgorithm(alg)) throw configError(`${helper}: unknown algorithm '${String(alg)}'. Use one of ${Object.keys(ALGORITHMS).join(', ')}.`);
    if (!allowed.includes(alg)) throw configError(`${helper}: algorithm '${alg}' does not fit the configured key (allowed: ${allowed.join(', ')}).`);
  }
  return algorithms as readonly JwtAlgorithm[];
}

/** Checks the claim options shared by `jwt()` and `oidc()`. */
export function checkClaimOptions(helper: string, options: Pick<JwtOptions, 'issuer' | 'audience' | 'allowAnyAudience' | 'clockToleranceSec'>): void {
  const tolerance = options.clockToleranceSec;
  if (tolerance !== undefined && !(Number.isFinite(tolerance) && tolerance >= 0 && tolerance <= MAX_CLOCK_TOLERANCE_SEC)) {
    throw configError(`${helper}: 'clockToleranceSec' must be between 0 and ${MAX_CLOCK_TOLERANCE_SEC}.`);
  }
  const audiences = list(options.audience);
  if (audiences.length === 0 && options.allowAnyAudience !== true) {
    throw configError(`${helper}: set 'audience' (the value your tokens carry in 'aud'), or 'allowAnyAudience: true' to skip the check.`);
  }
  if ([...audiences, ...list(options.issuer)].some((value) => typeof value !== 'string' || value === '')) {
    throw configError(`${helper}: 'issuer' and 'audience' values must be non-empty strings.`);
  }
}

const FAMILY_ALGORITHMS = (filter: (alg: JwtAlgorithm) => boolean) => (Object.keys(ALGORITHMS) as JwtAlgorithm[]).filter(filter);

function keyAlgorithms(key: { kty: KeyType; crv?: string }): readonly JwtAlgorithm[] {
  return FAMILY_ALGORITHMS((alg) => KEY_TYPE[ALGORITHMS[alg].family] === key.kty && (ALGORITHMS[alg].curve === undefined || ALGORITHMS[alg].curve === key.crv));
}

/**
 * Accepts a request whose `Authorization: Bearer` token is a JWT signed by the
 * configured key (`secret`, `publicKey` or `jwksUrl`: exactly one) with
 * valid `exp` / `nbf` / `iat`, the configured issuer and audience. Any other
 * bearer token, or none, skips to the next entry. Throws
 * `LOUSHO_AUTH_CONFIG_INVALID` for unusable options.
 *
 * @example
 * ```ts
 * jwt({ secret: process.env.JWT_SECRET!, issuer: 'https://auth.example.com', audience: 'agent-api' })
 * ```
 */
export function jwt(options: JwtOptions): AuthFn {
  const sources = [options.secret, options.publicKey, options.jwksUrl].filter((value) => value !== undefined);
  if (sources.length !== 1) throw configError("jwt(): give exactly one key source: 'secret', 'publicKey' or 'jwksUrl'.");
  checkClaimOptions('jwt()', options);
  let source: KeySource;
  let allowed: readonly JwtAlgorithm[];
  if (options.secret !== undefined) {
    if (typeof options.secret !== 'string' || new TextEncoder().encode(options.secret).length < MIN_SECRET_BYTES) {
      throw configError(`jwt(): 'secret' must be a string of at least ${MIN_SECRET_BYTES} bytes.`);
    }
    source = secretKeySource(options.secret);
    allowed = FAMILY_ALGORITHMS((alg) => ALGORITHMS[alg].family === 'HS');
  } else if (options.publicKey !== undefined) {
    const configured = publicKeySource(options.publicKey);
    source = configured.source;
    allowed = keyAlgorithms(configured.key);
    // Surface unusable key material at start-up instead of as silent 401s.
    void configured.key.importFor(allowed[0]).catch(() => console.warn("[lousho auth] jwt(): 'publicKey' could not be imported; every token will be refused."));
  } else {
    const url = options.jwksUrl as string;
    if (!isTrustedKeyUrl(url)) throw configError("jwt(): 'jwksUrl' must be an https URL (http only on localhost).");
    source = jwksKeySource(url, options.fetch ?? ((...args) => fetch(...args)));
    allowed = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384'];
  }
  const algorithms = checkAlgorithms('jwt()', options.algorithms, allowed);
  return bearerJwt({
    source,
    checks: {
      algorithms: options.algorithms === undefined && options.jwksUrl !== undefined ? ['RS256', 'ES256'] : algorithms,
      ...(options.issuer !== undefined && { issuer: options.issuer }),
      ...(options.audience !== undefined && { audience: options.audience }),
      ...(options.clockToleranceSec !== undefined && { clockToleranceSec: options.clockToleranceSec }),
    },
    principal: options.principal ?? claimsPrincipal('jwt'),
  });
}
