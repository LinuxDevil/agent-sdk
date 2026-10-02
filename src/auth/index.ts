/**
 * `@lousho/build-ai-agent/auth` (N10a): route auth helpers that run as an
 * ordered list and fail closed, and the `Principal` they hand to the run.
 * Web Crypto and `fetch` only: usable in Node, Workers and edge routes.
 * See docs/auth.md.
 */
export { AuthError, type AuthChallenge, type AuthFn, type AuthResult, type Principal } from './types';
export { routeAuth, type RouteAuthOutcome } from './routeAuth';
export { jwt, type JwtAlgorithm, type JwtClaims, type JwtOptions } from './jwt';
export { oidc, type OidcOptions } from './oidc';
export { anonymous, apiToken, basic, type BasicOptions } from './basic';
