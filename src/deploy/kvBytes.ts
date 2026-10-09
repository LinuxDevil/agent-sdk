/**
 * JSON for Workers KV records that can hold image and file bytes (Eve DUR-F5):
 * a `Uint8Array` is saved as `{ "$bytes": "<base64>" }`, the encoding of
 * `FileSessionStore`, so either store reads the other (see ../storage/jsonBytes).
 */
import { decodeBytes, encodeBytes } from '../storage/jsonBytes';

export { decodeBytes, encodeBytes };

/** `JSON.stringify(value)` with bytes encoded. */
export const toKVJson = (value: unknown): string => JSON.stringify(value, encodeBytes);

/** `JSON.parse(raw)` with bytes decoded. */
export const fromKVJson = <T>(raw: string): T => JSON.parse(raw, decodeBytes) as T;
