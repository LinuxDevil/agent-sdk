/**
 * LOU-U14: the one shape of a failed tool call. Every failure path (a thrown
 * error, invalid arguments, an unknown tool, a rejected approval, a call that
 * was never run, a call a permission rule denied, an MCP `isError` result, a
 * failed sandbox guard) hands the model the object {@link toolErrorResult} builds.
 */

/** Why a tool call produced an error result. */
export type ToolErrorKind =
  | 'execution'
  | 'validation'
  | 'not-found'
  | 'rejected'
  | 'not-run'
  | 'mcp'
  | 'sandbox'
  | 'denied';

/** Max characters of an error message sent to the model (see {@link toolErrorResult}). */
const MAX_TOOL_ERROR_MESSAGE_LENGTH = 2000;

/** The `error` name used when the failure is a plain message rather than an `Error`. */
const DEFAULT_ERROR_NAME: Record<ToolErrorKind, string> = {
  execution: 'Error',
  validation: 'ToolArgumentsValidationError',
  'not-found': 'ToolNotFoundError',
  rejected: 'ToolRejectedError',
  'not-run': 'ToolNotRunError',
  mcp: 'McpToolError',
  sandbox: 'SandboxRequiredError',
  denied: 'ToolDeniedError',
};

/**
 * The structured tool result the model sees for any failed tool call.
 *
 * @example
 * ```ts
 * // execute: async () => { throw new TypeError('bad input') }
 * // tool result the model sees:
 * // { error: 'TypeError', toolName: 'search', message: 'bad input', kind: 'execution' }
 * ```
 */
export interface ToolErrorResult {
  /** The error's name (`'TypeError'`, `'ToolNotFoundError'`, ...); always a non-empty string. */
  error: string;
  toolName: string;
  /** The message only (never a stack), truncated to 2,000 characters. */
  message: string;
  /** What kind of failure this is. */
  kind: ToolErrorKind;
  /** The model's id for the call, when the caller supplied it. */
  toolCallId?: string;
  /** Kind-specific extras, such as `issues` (validation) or `note` (rejected). */
  [extra: string]: unknown;
}

const KINDS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_ERROR_NAME));

/**
 * The kind a thrown error declares through its `toolErrorKind` property
 * (`McpToolError`, the sandbox guard's error, ...), or `'execution'`.
 */
function declaredKind(error: unknown): ToolErrorKind {
  const declared = (error as { toolErrorKind?: unknown } | null | undefined)?.toolErrorKind;
  return typeof declared === 'string' && KINDS.has(declared) ? (declared as ToolErrorKind) : 'execution';
}

/** Input of {@link toolErrorResult}. */
export interface ToolErrorInput {
  toolName: string;
  toolCallId?: string;
  /** A thrown value (its `name` and `message` are used) or a plain message. */
  error: unknown;
  /** Defaults to the kind the error declares, else `'execution'`. */
  kind?: ToolErrorKind;
  /** Extra fields (`issues`, `note`, ...); they never override the standard ones. */
  details?: Record<string, unknown>;
}

/**
 * Builds the {@link ToolErrorResult} for a failed tool call. Only the name
 * and (length-capped) message are exposed - never the stack - so a huge or
 * sensitive error cannot blow the context window.
 */
export function toolErrorResult(input: ToolErrorInput): ToolErrorResult {
  const { toolName, toolCallId, error, details } = input;
  const kind = input.kind ?? declaredKind(error);
  const err = typeof error === 'string' ? undefined : (error as { name?: unknown; message?: unknown } | null | undefined);
  const raw = typeof error === 'string' ? error : typeof err?.message === 'string' ? err.message : String(error);
  return {
    ...details,
    error: typeof err?.name === 'string' && err.name ? err.name : DEFAULT_ERROR_NAME[kind],
    toolName,
    message:
      raw.length > MAX_TOOL_ERROR_MESSAGE_LENGTH
        ? `${raw.slice(0, MAX_TOOL_ERROR_MESSAGE_LENGTH)}... (truncated)`
        : raw,
    kind,
    ...(toolCallId !== undefined && { toolCallId }),
  };
}
