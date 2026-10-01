import { SDKError } from '../../execution/errors';

/**
 * The error a built-in tool throws when its own work fails at run time (an
 * HTTP call that failed, an answer that was not given, ...). It carries
 * `LOUSHY_TOOL_EXECUTION_FAILED` for programmatic handling, but keeps the
 * message exactly as written: the model reads it as the tool's result, so the
 * `[code] hint (docs)` line is not appended.
 */
export function toolFailure(message: string, cause?: unknown): SDKError {
  return new SDKError(message, 'LOUSHY_TOOL_EXECUTION_FAILED', { appendHelp: false, ...(cause === undefined ? {} : { cause }) });
}
