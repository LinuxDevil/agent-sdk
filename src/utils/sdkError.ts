/**
 * The SDK's base error class. It lives here, apart from src/execution/errors.ts
 * (which re-exports it), because it imports nothing from `ai`: browser-side
 * code (src/ui, the React/Vue/Svelte entries) can throw it without pulling the
 * `ai` peer into its bundle.
 */

import { errorHelp, type ErrorCode } from './errorCodes';
import { instanceOfBranded } from './brand';

const SDK_ERROR_BRAND = Symbol.for('loushy.SDKError');

/** Options of {@link SDKError}. */
export interface SDKErrorOptions {
  /** One sentence on how to fix it; defaults to the registry's hint for `code`. */
  hint?: string;
  /** A docs link; defaults to the code's section of docs/errors.md. */
  docs?: string;
  cause?: unknown;
  /**
   * `false` keeps `message` exactly as given, for errors whose message is
   * also handed to the model (tool and provider errors); `toString()` still
   * shows the code, hint and docs link. Default `true`.
   */
  appendHelp?: boolean;
}

/** `message` plus a `[code] hint (docs)` line, the format every SDKError uses. */
function withHelp(message: string, code: string, hint?: string, docs?: string): string {
  const help = [`[${code}]`, hint, docs && `(${docs})`].filter(Boolean).join(' ');
  return `${message}\n${help}`;
}

/**
 * Base SDK error. `code` is stable (see docs/errors.md), `hint` says how to
 * fix it and `docs` links to its section; `message` ends with a
 * `[code] hint (docs)` line.
 *
 * @example
 * ```ts
 * try {
 *   await agent.send('hi');
 * } catch (error) {
 *   if (error instanceof SDKError && error.code === 'LOUSHY_APPROVAL_STORE_MISSING') console.error(error.hint);
 * }
 * ```
 */
export class SDKError extends Error {
  /** `instanceof SDKError` also holds for errors from another loaded copy of the SDK (LOU-D42). */
  static [Symbol.hasInstance](value: unknown): boolean {
    return instanceOfBranded(this, SDKError, SDK_ERROR_BRAND, value);
  }

  get [SDK_ERROR_BRAND](): true {
    return true;
  }

  readonly code: string;
  readonly hint?: string;
  readonly docs?: string;
  /** The message without the appended `[code] hint (docs)` line. */
  readonly detail: string;

  constructor(message: string, code: ErrorCode | (string & {}) = 'LOUSHY_GENERIC_ERROR', options: SDKErrorOptions = {}) {
    const help = errorHelp(code);
    const hint = options.hint ?? help?.hint;
    const docs = options.docs ?? help?.docs;
    super(
      options.appendHelp === false ? message : withHelp(message, code, hint, docs),
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = 'SDKError';
    this.code = code;
    this.hint = hint;
    this.docs = docs;
    this.detail = message;
  }

  override toString(): string {
    return `${this.name}: ${withHelp(this.detail, this.code, this.hint, this.docs)}`;
  }
}
