/**
 * Validates a model's tool-call arguments against the tool's zod parameter
 * schema before anything (hooks, approval gate, `execute`) sees them.
 */

import { ToolDescriptor } from '../types';
import { ToolExecutionError } from './errors';

/** One problem found while validating a tool call's arguments. */
export interface ToolArgumentIssue {
  /** Dot-joined path to the offending argument (`(root)` for the whole value). */
  path: string;
  /** Model-readable message, e.g. `Required` or `Expected number, received string`. */
  message: string;
}

/**
 * The model's tool-call arguments did not match the tool's parameter schema,
 * so `execute` was NOT called. Returned to the model as the tool result (the
 * run continues so it can correct itself); never thrown out of `execute()`.
 *
 * @example
 * ```ts
 * // tool result the model sees:
 * // { error: 'ToolArgumentsValidationError', toolName: 'sendEmail',
 * //   message: "Invalid arguments for tool 'sendEmail': 1 issue (to: Required)",
 * //   issues: [{ path: 'to', message: 'Required' }] }
 * ```
 */
export class ToolArgumentsValidationError extends ToolExecutionError {
  constructor(
    toolName: string,
    public readonly issues: ToolArgumentIssue[]
  ) {
    const detail = issues.map(i => `${i.path}: ${i.message}`).join('; ');
    super(
      `Invalid arguments for tool '${toolName}': ${issues.length} ${
        issues.length === 1 ? 'issue' : 'issues'
      } (${detail})`,
      toolName
    );
    this.name = 'ToolArgumentsValidationError';
  }

  /** The structured tool result handed to the model. */
  toToolResult(): {
    error: 'ToolArgumentsValidationError';
    toolName: string;
    message: string;
    issues: ToolArgumentIssue[];
  } {
    return {
      error: 'ToolArgumentsValidationError',
      toolName: this.toolName as string,
      message: this.message,
      issues: this.issues,
    };
  }
}

interface SafeParseResult {
  success: boolean;
  data?: unknown;
  error?: { issues: Array<{ path: Array<string | number>; message: string }> };
}

interface ParseableSchema {
  safeParse(value: unknown): SafeParseResult;
  safeParseAsync?(value: unknown): Promise<SafeParseResult>;
}

function isParseable(schema: unknown): schema is ParseableSchema {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  );
}

/**
 * Parses `args` with the tool's schema and returns the parsed value (zod
 * defaults/coercions/transforms applied). Tools without a zod-style schema
 * pass through unchanged.
 *
 * @throws ToolArgumentsValidationError listing every issue with its path.
 */
export async function validateToolArguments(
  toolName: string,
  toolDesc: ToolDescriptor,
  args: unknown
): Promise<unknown> {
  const schema = (toolDesc.tool as { parameters?: unknown }).parameters;
  if (!isParseable(schema)) {
    return args;
  }

  const result = schema.safeParseAsync
    ? await schema.safeParseAsync(args)
    : schema.safeParse(args);
  if (result.success) {
    return result.data;
  }

  const issues: ToolArgumentIssue[] = (result.error?.issues ?? []).map(issue => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
  throw new ToolArgumentsValidationError(toolName, issues);
}
