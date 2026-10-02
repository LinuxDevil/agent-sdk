/**
 * GitHub App authentication (N11b), with `fetch` and Web Crypto only (no
 * `node:*` import): the app's private key signs a short-lived RS256 JWT, which
 * is exchanged for an installation access token. Not exported from the package
 * root; `githubChannel({ app })` uses it.
 */
import { toBase64Url } from '../utils/base64url';
import { ConfigurationError, SDKError } from '../execution/errors';

/** Options of {@link createInstallationTokens}. */
export interface GitHubAppAuthOptions {
  appId: string;
  /** The app's private key as PEM: PKCS#1 (`BEGIN RSA PRIVATE KEY`, what GitHub downloads) or PKCS#8 (`BEGIN PRIVATE KEY`). */
  privateKey: string;
  /** Default `https://api.github.com`. */
  apiUrl?: string;
  fetch?: typeof fetch;
  /** The clock in milliseconds (tests). Default `Date.now`. */
  now?: () => number;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const PEM = /-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([\s\S]*?)-----END \1-----/;

const encoder = new TextEncoder();

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** One DER element: the tag, the length (short or long form) and the content. */
function der(tag: number, content: Uint8Array): Uint8Array {
  const length = content.length;
  const size = length < 0x80 ? [length] : length < 0x100 ? [0x81, length] : length < 0x10000 ? [0x82, length >> 8, length & 0xff] : [0x83, length >> 16, (length >> 8) & 0xff, length & 0xff];
  const out = new Uint8Array(1 + size.length + length);
  out[0] = tag;
  out.set(size, 1);
  out.set(content, 1 + size.length);
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** `AlgorithmIdentifier { rsaEncryption, NULL }`, the fixed part of a PKCS#8 RSA key. */
const RSA_ALGORITHM = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/**
 * The PKCS#8 DER bytes of a PEM private key. A PKCS#1 key (`BEGIN RSA PRIVATE
 * KEY`) is wrapped as `PrivateKeyInfo { 0, rsaEncryption, OCTET STRING }`, which
 * is what Web Crypto can import; a PKCS#8 key is decoded as is. Literal `\n`
 * sequences (a key kept in an environment variable) are accepted.
 */
export function pemToPkcs8(pem: string): Uint8Array {
  const match = PEM.exec(pem.replace(/\\n/g, '\n'));
  if (!match) throw new ConfigurationError("githubChannel: app.privateKey must be a PEM private key ('BEGIN RSA PRIVATE KEY' or 'BEGIN PRIVATE KEY').", 'app.privateKey');
  let body: Uint8Array;
  try {
    body = fromBase64(match[2].replace(/\s+/g, ''));
  } catch {
    throw new ConfigurationError('githubChannel: app.privateKey is not valid PEM.', 'app.privateKey');
  }
  if (match[1] === 'PRIVATE KEY') return body;
  return der(0x30, concat(Uint8Array.from([0x02, 0x01, 0x00]), RSA_ALGORITHM, der(0x04, body)));
}

/** A signed RS256 JWT for the app: `iat` a minute in the past (clock drift), `exp` nine minutes ahead (GitHub allows ten). */
export async function signAppJwt(appId: string, privateKey: string, nowMs: number = Date.now()): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('pkcs8', new Uint8Array(pemToPkcs8(privateKey)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError('githubChannel: app.privateKey could not be imported as an RSA key.', 'app.privateKey');
  }
  const seconds = Math.floor(nowMs / 1000);
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = toBase64Url(encoder.encode(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId })));
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${toBase64Url(signature)}`;
}

/**
 * Installation access tokens for a GitHub App: `(installationId) => token`.
 * The token is fetched with `POST /app/installations/{id}/access_tokens` and
 * cached per installation until 5 minutes before it expires. Errors name the
 * call and the status, never the key, the JWT or a token.
 */
export function createInstallationTokens(options: GitHubAppAuthOptions): (installationId: number) => Promise<string> {
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? Date.now;
  const cache = new Map<number, { token: Promise<string>; expiresAt: number }>();

  async function exchange(installationId: number): Promise<{ token: string; expiresAt: number }> {
    const jwt = await signAppJwt(options.appId, options.privateKey, now());
    const call = `POST /app/installations/${installationId}/access_tokens`;
    let res: Response;
    try {
      res = await doFetch(`${apiUrl}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'lousho' },
      });
    } catch {
      throw new SDKError(`githubChannel: ${call} failed: the request did not complete`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
    }
    if (!res.ok) throw new SDKError(`githubChannel: ${call} failed: ${res.status}`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
    const body = (await res.json().catch(() => ({}))) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== 'string' || !body.token) throw new SDKError(`githubChannel: ${call} failed: the answer has no token`, 'LOUSHO_CHANNEL_REQUEST_FAILED');
    const expires = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : NaN;
    return { token: body.token, expiresAt: Number.isNaN(expires) ? now() + 55 * 60 * 1000 : expires };
  }

  return (installationId) => {
    const cached = cache.get(installationId);
    if (cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
    // the promise is cached at once, so concurrent events share one exchange
    const entry = { token: undefined as unknown as Promise<string>, expiresAt: Number.POSITIVE_INFINITY };
    entry.token = exchange(installationId).then(
      ({ token, expiresAt }) => {
        entry.expiresAt = expiresAt;
        return token;
      },
      (error: unknown) => {
        if (cache.get(installationId) === entry) cache.delete(installationId);
        throw error;
      }
    );
    cache.set(installationId, entry);
    return entry.token;
  };
}
