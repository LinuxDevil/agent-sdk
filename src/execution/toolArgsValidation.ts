/**
 * Validates a model's tool-call arguments against the tool's zod parameter
 * schema before anything (hooks, approval gate, `execute`) sees them.
 */

import { ToolDescriptor } from '../types';
import { ToolExecutionError } from './errors';
import { getToolInputSchema } from '../tools/toolContract';
import { toolErrorResult, type ToolErrorResult } from './toolErrors';

/** One problem found while validating a tool call's arguments. */
export interface ToolArgumentIssue {
  /** Dot-joined path to the offending argument (`(root)` for the whole value). */
  path: string;
  /** Model-readable message, e.g. `Required` or `Expected number, received string`. */
  message: string;
}

/** `2 issues (to: Required; cc: Expected array, received string)` - the model-readable summary. */
export function formatIssues(issues: ToolArgumentIssue[]): string {
  const detail = issues.map(i => `${i.path}: ${i.message}`).join('; ');
  return `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'} (${detail})`;
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
 * //   kind: 'validation', issues: [{ path: 'to', message: 'Required' }] }
 * ```
 */
export class ToolArgumentsValidationError extends ToolExecutionError {
  /** Read by toolErrorResult() when this is thrown from a tool. */
  readonly toolErrorKind = 'validation' as const;

  constructor(
    toolName: string,
    public readonly issues: ToolArgumentIssue[]
  ) {
    super(`Invalid arguments for tool '${toolName}': ${formatIssues(issues)}`, toolName);
    this.name = 'ToolArgumentsValidationError';
  }

  /** The structured tool result handed to the model. */
  toToolResult(): ToolErrorResult & { issues: ToolArgumentIssue[] } {
    return {
      ...toolErrorResult({
        toolName: this.toolName as string,
        error: this,
        kind: 'validation',
      }),
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
  const schema = getToolInputSchema(toolDesc);
  if (!isParseable(schema)) {
    return args;
  }

  const result = await parseWithIssues(schema, args);
  if (result.success) {
    return result.data;
  }
  throw new ToolArgumentsValidationError(toolName, result.issues);
}

/** Parses `value` with a zod-style schema: the parsed value, or every issue with its path. */
export async function parseWithIssues(
  schema: ParseableSchema,
  value: unknown
): Promise<{ success: true; data: unknown } | { success: false; issues: ToolArgumentIssue[] }> {
  const result = schema.safeParseAsync ? await schema.safeParseAsync(value) : schema.safeParse(value);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const issues: ToolArgumentIssue[] = (result.error?.issues ?? []).map(issue => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
  return { success: false, issues };
}
