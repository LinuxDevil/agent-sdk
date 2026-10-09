/**
 * JSON for stored records that can hold image and file bytes (Eve DUR-F5): a
 * `Uint8Array` is saved as `{ "$bytes": "<base64>" }`, the encoding of
 * `FileSessionStore`, so every store reads the others. It uses `btoa`/`atob`
 * rather than `Buffer`, so it also runs on Workers (KVStore) and in modules
 * that avoid Node builtins (StorageService).
 */

/** `JSON.stringify` replacer: a `Uint8Array` (a `Buffer` too, read before its `toJSON()`) becomes `{ $bytes }`. */
export function encodeBytes(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key];
  if (!(raw instanceof Uint8Array)) return value;
  let binary = '';
  for (let start = 0; start < raw.length; start += 0x8000) binary += String.fromCharCode(...raw.subarray(start, start + 0x8000));
  return { $bytes: btoa(binary) };
}

/** `JSON.parse` reviver: `{ $bytes }` back to a `Uint8Array`. */
export function decodeBytes(_key: string, value: unknown): unknown {
  const base64 = typeof value === 'object' && value !== null && Object.keys(value).length === 1 ? (value as Record<string, unknown>).$bytes : undefined;
  return typeof base64 === 'string' ? Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)) : value;
}
