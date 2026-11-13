/**
 * Errors the bridge itself raises (as opposed to SDKErrors a handler lets
 * through): a stable wire `code`, a clean `message` (no appended help
 * line), and optional `details` the response carries verbatim.
 */
import { SDKError } from '../execution/errors';
import type { BridgeErrorInfo } from './protocol';

/** An error `serveBridge` answers as `{ id, error: { code, message, details? } }`. */
export class BridgeError extends SDKError {
  /** Method-specific context (e.g. `LOUSHO_BRIDGE_PROTOCOL`'s `supported` list, BAD_PARAMS' issues). */
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message, code, { appendHelp: false });
    this.name = 'BridgeError';
    this.details = details;
  }
}

/**
 * Maps a thrown error to the wire `error`/`run.failed` shape: an
 * `SDKError`'s code and message pass through (with `details` when it has
 * them); anything else is `LOUSHO_BRIDGE_INTERNAL`.
 */
export function toBridgeErrorInfo(error: unknown): BridgeErrorInfo {
  if (error instanceof SDKError) {
    const details = (error as { details?: unknown }).details;
    return { code: error.code, message: error.message, ...(details !== undefined && { details }) };
  }
  return { code: 'LOUSHO_BRIDGE_INTERNAL', message: error instanceof Error ? error.message : String(error) };
}
