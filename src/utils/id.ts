/**
 * Generates a unique id. Uses the Web Crypto `randomUUID()` that Node 22+ and
 * Cloudflare Workers both provide as a global, so it needs no dependency and
 * no `node:*` import (the deploy runtime bundles for Workers).
 *
 * @param prefix Optional prefix, joined to the id with an underscore.
 */
export function newId(prefix?: string): string {
  const id = globalThis.crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}
