import type { ApprovalCheckContext, ApprovalOutcome, McpToolAnnotations, ToolDescriptor, ToolExecutionContext } from '../types';
import type { SandboxAdapter } from '../security/sandboxCore';
import { legacyAiTool } from './toolContract';
import { isModelSchema, type InferSchemaOutput, type StandardSchemaV1 } from '../utils/zodCompat';
import { SDKError } from '../execution/errors';

/** Tool names must satisfy the constraint LLM providers impose on function names. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Options accepted by {@link defineTool}. */
export interface DefineToolOptions<S extends StandardSchemaV1, R> {
  /** Name the model calls the tool by. Must match `^[a-zA-Z0-9_-]{1,64}$`. */
  name: string;
  /** What the tool does; shown to the model. */
  description: string;
  /**
   * Schema of the arguments: zod 3 or zod 4 (LOU-D29), or another Standard
   * Schema that exposes its JSON Schema (`~standard.jsonSchema`). `execute`
   * and `needsApproval` receive its parsed (output) type.
   */
  input: S;
  /** Human-readable label for UIs. Defaults to `name`. */
  displayName?: string;
  /**
   * Pause for human approval before running. A boolean, or a function
   * receiving the validated arguments (typed from `input`) that returns a
   * boolean or an {@link ApprovalOutcome} (`'ask'`, `'approve'`, `'deny'`,
   * `{ deny: reason }`); see `always()`, `never()` and `once()`.
   */
  needsApproval?:
    | boolean
    | ((args: InferSchemaOutput<S>, ctx: ApprovalCheckContext) => ApprovalOutcome | Promise<ApprovalOutcome>);
  /**
   * MCP hints about the tool (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
   * `openWorldHint`, `title`). `serveMcp()` sends them to MCP clients verbatim, and a
   * Lousho agent consuming that server skips approval for `readOnlyHint: true`.
   * Stored as `metadata.mcp.annotations`. A tool that needs approval is never
   * advertised as read-only, whatever is set here.
   */
  annotations?: McpToolAnnotations;
  /**
   * N4: the tool edits files (like `write_file` and `edit_file`), so
   * `permissionMode: 'acceptEdits'` runs its calls without asking. Stored as
   * `metadata.editsFiles`. A tool is never a file edit by its name alone.
   */
  editsFiles?: boolean;
  /**
   * N2: withhold this tool's definition from the model until it finds the
   * tool with the built-in `tool_search` tool. Use it for large tool sets;
   * `createAgent({ toolSearch })` tunes when deferral applies. See
   * docs/tool-search.md.
   */
  deferLoading?: boolean;
  /** Route execution through the configured SandboxAdapter (requires `sandboxExecute`). */
  requiresSandbox?: boolean;
  /** Sandboxed execution path used instead of `execute` when `requiresSandbox` is true. */
  sandboxExecute?: (args: InferSchemaOutput<S>, sandbox: SandboxAdapter) => Promise<unknown>;
  /**
   * Runs the tool. Arguments are typed from `input`; the return type is preserved on the result.
   * N13b: may be an `async function*`: each `yield` is a complete snapshot of the output, streamed
   * as a `tool.partial` event, and the last one is the result the model receives (see {@link ToolResultOf}).
   */
  execute: (args: InferSchemaOutput<S>, ctx: ToolExecutionContext) => R | Promise<R>;
}

/**
 * N13b: the result type of a tool whose `execute` returns `R`: the yielded
 * type when `R` is an async generator (an async iterator that is also async
 * iterable - the snapshots it yields stream as `tool.partial`, the last one is
 * the result), else `Awaited<R>`.
 */
export type ToolResultOf<R> = R extends AsyncIterator<infer Y> & AsyncIterable<unknown> ? Y : Awaited<R>;

/**
 * A tool created by {@link defineTool}. It is a regular {@link ToolDescriptor}
 * (so it works anywhere a descriptor does) that also carries its `name` and
 * input/output types - see {@link ToolInput} and {@link ToolOutput}.
 * `inputSchema` and `execute` are the canonical contract; `tool` is a
 * legacy `ai` v4-shaped copy of them. `X` is what `execute` resolves to: the
 * output `O`, or (N13b) the async generator of a streaming tool.
 */
export interface DefinedTool<S extends StandardSchemaV1 = StandardSchemaV1, O = unknown, X = O>
  extends ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly input: S;
  /** Same schema as `input`. */
  readonly inputSchema: S;
  execute(args: InferSchemaOutput<S>, ctx: ToolExecutionContext): Promise<X>;
  /** Type-only marker; never set at runtime. */
  readonly _types?: { input: InferSchemaOutput<S>; output: O };
}

/** The (parsed) argument type of a defined tool. */
export type ToolInput<T extends DefinedTool> = InferSchemaOutput<T['input']>;

/** The awaited return type of a defined tool's `execute`; for a generator `execute` (N13b), the type it yields. */
export type ToolOutput<T extends DefinedTool> = NonNullable<T['_types']>['output'];

const definedTools = new WeakSet<object>();

/** True when `value` was created by {@link defineTool}. */
export function isDefinedTool(value: unknown): value is DefinedTool {
  return typeof value === 'object' && value !== null && definedTools.has(value);
}

function fail(problem: string, fix: string): never {
  throw new SDKError(`defineTool: ${problem}. ${fix}`, 'LOUSHO_CONFIG_INVALID');
}

function assertValidOptions(opts: { name?: unknown; description?: unknown; input?: unknown; execute?: unknown }): void {
  const { name, description, input, execute } = opts;
  if (typeof name !== 'string' || name === '') {
    fail("'name' is required", "Example: defineTool({ name: 'send_email', ... })");
  }
  if (!TOOL_NAME_PATTERN.test(name)) {
    fail(
      `invalid tool name ${JSON.stringify(name)} (LLM providers only accept 1-64 characters from A-Z, a-z, 0-9, '_' and '-')`,
      `Rename it, e.g. ${JSON.stringify(name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'my_tool')}`
    );
  }
  if (typeof description !== 'string' || description.trim() === '') {
    fail(
      `tool '${name}' is missing a 'description' (the model uses it to decide when to call the tool)`,
      `Example: defineTool({ name: '${name}', description: 'Send an email', ... })`
    );
  }
  if (!isModelSchema(input)) {
    fail(
      `tool '${name}' needs a zod schema as 'input'`,
      `Import { z } from 'zod' (zod 3 or 4) and pass e.g. input: z.object({ query: z.string() })`
    );
  }
  if (typeof execute !== 'function') {
    fail(`tool '${name}' needs an 'execute' function`, `Example: execute: async (args) => ({ ok: true })`);
  }
}

/**
 * Define a tool with arguments and result types inferred from its zod schema.
 *
 * The result is a {@link ToolDescriptor}, so it can be passed to
 * `createAgent({ tools: [...] })`, `ToolRegistry.register(tool)`,
 * `AgentBuilder.addTool(tool)` and anywhere else tools are accepted.
 *
 * @example
 * ```ts
 * const sendEmail = defineTool({
 *   name: 'send_email',
 *   description: 'Send an email',
 *   input: z.object({ to: z.string().email(), subject: z.string() }),
 *   needsApproval: ({ to }) => !to.endsWith('@mycompany.com'), // `to` is a string
 *   async execute({ to, subject }) {
 *     return { messageId: `${to}:${subject}` };
 *   },
 * });
 * type Result = ToolOutput<typeof sendEmail>; // { messageId: string }
 *
 * // N13b: a generator streams snapshots (`tool.partial`); the last one is the result.
 * const report = defineTool({
 *   name: 'build_report',
 *   description: 'Build a report',
 *   input: z.object({ topic: z.string() }),
 *   async *execute({ topic }) {
 *     yield { topic, progress: 0.5, done: false };
 *     yield { topic, progress: 1, done: true };
 *   },
 * });
 * type Snapshot = ToolOutput<typeof report>; // { topic: string; progress: number; done: boolean }
 * ```
 */
export function defineTool<S extends StandardSchemaV1, R>(
  opts: DefineToolOptions<S, R>
): DefinedTool<S, ToolResultOf<R>, Awaited<R>> {
  assertValidOptions(opts);

  // N13b: an async generator passes through unchanged (it is not thenable); the runtime iterates it.
  const execute = async (args: InferSchemaOutput<S>, ctx: ToolExecutionContext): Promise<Awaited<R>> =>
    await opts.execute(args, ctx);
  // legacy (.tool): the `ai` v4 Tool shape. Removed in D26.
  const legacyTool = legacyAiTool(opts.description, opts.input, execute as NonNullable<ToolDescriptor['execute']>);
  const defined: DefinedTool<S, ToolResultOf<R>, Awaited<R>> = {
    name: opts.name,
    description: opts.description,
    input: opts.input,
    inputSchema: opts.input,
    execute,
    displayName: opts.displayName ?? opts.name,
    tool: legacyTool,
    needsApproval: opts.needsApproval,
    requiresSandbox: opts.requiresSandbox,
    sandboxExecute: opts.sandboxExecute as ToolDescriptor['sandboxExecute'],
    ...(opts.deferLoading !== undefined && { deferLoading: opts.deferLoading }),
    ...toolMetadata(opts),
  };
  definedTools.add(defined);
  return defined;
}

/** `metadata` from the options: MCP `annotations` (LOU-Z5) and the `editsFiles` marker (N4); none when neither is set. */
function toolMetadata(opts: Pick<DefineToolOptions<StandardSchemaV1, unknown>, 'annotations' | 'editsFiles'>): Pick<ToolDescriptor, 'metadata'> {
  if (!opts.annotations && !opts.editsFiles) return {};
  return { metadata: { ...(opts.annotations && { mcp: { annotations: opts.annotations } }), ...(opts.editsFiles && { editsFiles: true }) } };
}
