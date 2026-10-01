/**
 * Host-name patterns shared by the sandbox network policy (LOU-X11) and the
 * credential broker (LOU-X12): an exact name (`api.github.com`) or a `*.`
 * wildcard over one (`*.npmjs.org`, which matches subdomains only).
 */

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** A host name (`api.github.com`) or a `*.` wildcard over one (`*.npmjs.org`). */
export function isHostPattern(host: unknown): host is string {
  if (typeof host !== 'string' || host.length > 255) return false;
  const labels = (host.startsWith('*.') ? host.slice(2) : host).split('.');
  return labels.every((label) => HOST_LABEL.test(label));
}

/** True if `host` (already lower-cased) matches one of the lower-cased `patterns`. */
export function matchesHost(patterns: readonly string[], host: string): boolean {
  return patterns.some((pattern) => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern));
}
