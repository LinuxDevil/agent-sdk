import { SDKError } from '../utils/sdkError';
import { brandClass } from '../utils/brand';
import type { SandboxErrorKind } from './types';

/**
 * A run failed at the sandbox boundary: a timeout (`kind: 'timeout'`), a
 * memory-limit kill (`'oom'`) or a driver fault (`'driver'`). The `kind`
 * lands on the tool span as `sandbox.error` and in the tool error result's
 * `sandboxError` field.
 *
 * An error the sandboxed code itself threw is not a SandboxError: it crosses
 * the boundary unchanged and reports as an ordinary tool error.
 */
export class SandboxError extends SDKError {
  /** ToolErrorResult's `kind` for a sandboxed tool call that failed at the boundary. */
  readonly toolErrorKind = 'sandbox' as const;

  constructor(
    message: string,
    /** Which boundary failed (the `sandbox.error` span attribute value). */
    readonly kind: SandboxErrorKind,
    /** The driver that reported it (the `sandbox.driver` span attribute value). */
    readonly driver: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, 'LOUSHO_SANDBOX_FAILED', { appendHelp: false, cause: options.cause });
    this.name = 'SandboxError';
  }
}
brandClass(SandboxError, 'SandboxError');

/**
 * The {@link SandboxError.kind} of the first SandboxError on `error`'s
 * `cause` chain, or undefined. Internal: tool-call error handling uses it to
 * keep the `sandbox.error` span attribute through the error-to-result path.
 */
export function sandboxErrorKind(error: unknown, depth = 0): SandboxErrorKind | undefined {
  if (depth > 4 || error === null || typeof error !== 'object') return undefined;
  if (error instanceof SandboxError) return error.kind;
  return sandboxErrorKind((error as { cause?: unknown }).cause, depth + 1);
}
