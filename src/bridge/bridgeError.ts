/**
 * Errors the bridge itself raises (as opposed to SDKErrors a handler lets
 * through): a stable wire `code`, a clean `message` (no appended help
 * line), and optional `details` the response carries verbatim.
 */
import { SDKError } from '../execution/errors';

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
