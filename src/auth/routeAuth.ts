/**
 * N10a: run a route's auth list. Entries are tried in order: the first
 * `Principal` wins, `null` / `undefined` skips to the next entry, an
 * `AuthError` stops the walk with its status. When every entry skips (or the
 * list is empty) the answer is a generic 401 carrying one `WWW-Authenticate`
 * header per distinct challenge. Response bodies never say which check failed.
 * No `node:*` import.
 */
import { basicChallenge } from './basic';
import { AuthError, type AuthChallenge, type AuthFn, type Principal } from './types';

export type RouteAuthOutcome = { ok: true; principal: Principal } | { ok: false; response: Response };

function respond(status: number, error: string, challenges: readonly string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const challenge of challenges) headers.append('www-authenticate', challenge);
  return new Response(JSON.stringify({ error }), { status, headers });
}

function challengeHeader(challenge: AuthChallenge): string {
  return challenge.scheme === 'Basic' ? basicChallenge(challenge.realm) : challenge.realm ? `Bearer realm="${challenge.realm.replace(/[\\"]/g, '\\$&')}"` : 'Bearer';
}

/** One header per distinct challenge, in list order; an entry without `challenges` advertises `Bearer`. */
function challenges(entries: readonly AuthFn[]): string[] {
  const values = entries.flatMap((entry) => (entry.challenges ?? [{ scheme: 'Bearer' as const }]).map(challengeHeader));
  return [...new Set(values.length > 0 ? values : ['Bearer'])];
}

function isPrincipal(value: unknown): value is Principal {
  const principal = value as Partial<Principal> | null;
  return (
    typeof principal === 'object' &&
    principal !== null &&
    typeof principal.id === 'string' &&
    principal.id !== '' &&
    (principal.type === 'user' || principal.type === 'service') &&
    typeof principal.authenticator === 'string'
  );
}

/** The 401 every unauthenticated request gets. */
export function unauthorized(entries: readonly AuthFn[]): Response {
  return respond(401, 'Unauthorized', challenges(entries));
}

/**
 * Decides `request` with `auth` (one entry or an ordered list). Resolves the
 * accepted principal, or the response to send instead: 401 when every entry
 * skipped, the `AuthError`'s 401 / 403, or a 500 (logged, generic body) when an
 * entry failed in any other way or returned something that is not a principal.
 *
 * @example
 * ```ts
 * const outcome = await routeAuth(request, [jwt({ ... }), apiToken(process.env.CI_TOKEN!)]);
 * if (!outcome.ok) return outcome.response;
 * await agent.send(input, { principal: outcome.principal });
 * ```
 */
export async function routeAuth(request: Request, auth: AuthFn | readonly AuthFn[]): Promise<RouteAuthOutcome> {
  const entries: readonly AuthFn[] = Array.isArray(auth) ? auth : [auth as AuthFn];
  for (const entry of entries) {
    let result: unknown;
    try {
      result = await entry(request);
    } catch (error) {
      if (error instanceof AuthError) {
        return { ok: false, response: error.status === 403 ? respond(403, 'Forbidden') : unauthorized(entries) };
      }
      console.error('[lousho auth] an auth function threw; answering 500:', error);
      return { ok: false, response: respond(500, 'Internal Server Error') };
    }
    if (result === null || result === undefined) continue;
    if (!isPrincipal(result)) {
      console.error('[lousho auth] an auth function returned something that is not a Principal ({ id, type, authenticator }), null or undefined; answering 500.');
      return { ok: false, response: respond(500, 'Internal Server Error') };
    }
    return { ok: true, principal: result };
  }
  return { ok: false, response: unauthorized(entries) };
}
