/**
 * Validates a model's tool-call arguments against the tool's zod parameter
 * schema (zod 3, zod 4 or any Standard Schema) before anything (hooks,
 * approval gate, `execute`) sees them.
 */

import { ToolDescriptor } from '../types';
import type { ToolCall } from '../providers';
import { ToolExecutionError } from './errors';
import { getToolInputSchema } from '../tools/toolContract';
import { toolErrorResult, type ToolErrorResult } from './toolErrors';
import { issueMessage, issuePath, type SchemaIssue, type StandardSchemaV1 } from '../utils/zodCompat';

/** A tool call's raw `arguments`, decoded (see {@link decodeToolArguments}). */
export type DecodedToolArguments =
  | {
      ok: true;
      /** The parsed arguments. */
      value: unknown;
      /** True when the text only parsed after a repair (code fence, trailing comma, double encoding). */
      repaired?: boolean;
    }
  | {
      ok: false;
      /** The JSON parser's message. */
      error: string;
    };

/** Strips a surrounding markdown code fence (` ```json ... ``` `). */
function stripCodeFence(text: string): string {
  const fenced = /^```[\w-]*\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return fenced ? fenced[1] : text;
}

/** Removes commas directly before a closing `}` or `]`, leaving string contents alone. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === '\\') out += text[++i] ?? '';
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    if (char === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) continue;
    out += char;
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses `text` to an object, unwrapping one level of double encoding; undefined otherwise. */
function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (isObject(value)) return value;
    if (typeof value === 'string') {
      const inner: unknown = JSON.parse(value);
      if (isObject(inner)) return inner;
    }
  } catch {
    // not this shape
  }
  return undefined;
}

/**
 * Decodes a tool call's JSON `arguments`. An empty string means no
 * arguments (`{}`), as many models send for a tool without parameters.
 * Text that is not valid JSON gets one small repair pass (a surrounding
 * markdown code fence, trailing commas, a double-encoded JSON string),
 * kept only when it yields an object; otherwise the parse error is returned.
 */
export function decodeToolArguments(raw: unknown): DecodedToolArguments {
  if (typeof raw !== 'string') return { ok: true, value: raw ?? {} };
  if (raw.trim() === '') return { ok: true, value: {} };
  let error: string;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'string') return { ok: true, value };
    const unwrapped = parseObject(raw);
    return unwrapped ? { ok: true, value: unwrapped, repaired: true } : { ok: true, value };
  } catch (parseError) {
    error = parseError instanceof Error ? parseError.message : String(parseError);
  }
  const unfenced = stripCodeFence(raw);
  const repaired = parseObject(unfenced) ?? parseObject(stripTrailingCommas(unfenced));
  return repaired ? { ok: true, value: repaired, repaired: true } : { ok: false, error };
}

/** The model-readable reason a call's arguments could not be decoded, with the (truncated) raw text. */
export function invalidJsonMessage(raw: string, error: string): string {
  const received = raw.length > 200 ? `${raw.slice(0, 200)}... (${raw.length} chars)` : raw;
  return `arguments are not valid JSON: ${error}; received: ${received}`;
}

/**
 * Best-effort parse of a tool call's JSON `arguments` (see
 * {@link decodeToolArguments}), returning `fallback` when they are not valid JSON.
 */
export function parseToolArguments(toolCall: ToolCall, fallback: unknown): unknown {
  const decoded = decodeToolArguments(toolCall.function.arguments);
  return decoded.ok ? decoded.value : fallback;
}

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
    super(`Invalid arguments for tool '${toolName}': ${formatIssues(issues)}`, toolName, undefined, 'LOUSHO_TOOL_ARGS_INVALID');
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
  error?: { issues: readonly SchemaIssue[] };
}

/** A zod schema of either major (`safeParse`), or any Standard Schema (`~standard.validate`). */
type ParseableSchema = Partial<StandardSchemaV1> & {
  safeParse?(value: unknown): SafeParseResult;
  safeParseAsync?(value: unknown): Promise<SafeParseResult>;
};

function isParseable(schema: unknown): schema is ParseableSchema {
  const candidate = schema as ParseableSchema | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    (typeof candidate.safeParse === 'function' || typeof candidate['~standard']?.validate === 'function')
  );
}

/** Runs the schema: zod's own `safeParseAsync`/`safeParse`, else the Standard Schema `validate`. */
async function runSchema(schema: ParseableSchema, value: unknown): Promise<SafeParseResult> {
  if (schema.safeParseAsync) return schema.safeParseAsync(value);
  if (schema.safeParse || !schema['~standard']) return schema.safeParse?.(value) ?? { success: true, data: value };
  const result = await schema['~standard'].validate(value);
  return result.issues ? { success: false, error: { issues: result.issues } } : { success: true, data: result.value };
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
  const result = await runSchema(schema, value);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const issues: ToolArgumentIssue[] = (result.error?.issues ?? []).map(issue => ({
    path: issuePath(issue),
    message: issueMessage(issue),
  }));
  return { success: false, issues };
}
