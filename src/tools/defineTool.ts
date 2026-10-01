import type { z } from 'zod';
import type { ApprovalCheckContext, ApprovalOutcome, McpToolAnnotations, ToolDescriptor, ToolExecutionContext } from '../types';
import type { SandboxAdapter } from '../security/sandboxCore';
import { legacyAiTool } from './toolContract';

/** Tool names must satisfy the constraint LLM providers impose on function names. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Options accepted by {@link defineTool}. */
export interface DefineToolOptions<S extends z.ZodTypeAny, R> {
  /** Name the model calls the tool by. Must match `^[a-zA-Z0-9_-]{1,64}$`. */
  name: string;
  /** What the tool does; shown to the model. */
  description: string;
  /** Zod schema of the arguments. `execute` and `needsApproval` receive its parsed (output) type. */
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
    | ((args: z.output<S>, ctx: ApprovalCheckContext) => ApprovalOutcome | Promise<ApprovalOutcome>);
  /**
   * MCP hints about the tool (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
   * `openWorldHint`, `title`). `serveMcp()` sends them to MCP clients verbatim, and a
   * Loushy agent consuming that server skips approval for `readOnlyHint: true`.
   * Stored as `metadata.mcp.annotations`. A tool that needs approval is never
   * advertised as read-only, whatever is set here.
   */
  annotations?: McpToolAnnotations;
  /** Route execution through the configured SandboxAdapter (requires `sandboxExecute`). */
  requiresSandbox?: boolean;
  /** Sandboxed execution path used instead of `execute` when `requiresSandbox` is true. */
  sandboxExecute?: (args: z.output<S>, sandbox: SandboxAdapter) => Promise<unknown>;
  /** See {@link ToolDescriptor.injectStreamingController}. */
  injectStreamingController?: ToolDescriptor['injectStreamingController'];
  /** Runs the tool. Arguments are typed from `input`; the return type is preserved on the result. */
  execute: (args: z.output<S>, ctx: ToolExecutionContext) => R | Promise<R>;
}

/**
 * A tool created by {@link defineTool}. It is a regular {@link ToolDescriptor}
 * (so it works anywhere a descriptor does) that also carries its `name` and
 * input/output types - see {@link ToolInput} and {@link ToolOutput}.
 * `inputSchema` and `execute` are the canonical contract; `tool` is a
 * legacy `ai` v4-shaped copy of them.
 */
export interface DefinedTool<S extends z.ZodTypeAny = z.ZodTypeAny, O = unknown>
  extends ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly input: S;
  /** Same schema as `input`. */
  readonly inputSchema: S;
  execute(args: z.output<S>, ctx: ToolExecutionContext): Promise<O>;
  /** Type-only marker; never set at runtime. */
  readonly _types?: { input: z.output<S>; output: O };
}

/** The (parsed) argument type of a defined tool. */
export type ToolInput<T extends DefinedTool> = z.output<T['input']>;

/** The awaited return type of a defined tool's `execute`. */
export type ToolOutput<T extends DefinedTool> = NonNullable<T['_types']>['output'];

const definedTools = new WeakSet<object>();

/** True when `value` was created by {@link defineTool}. */
export function isDefinedTool(value: unknown): value is DefinedTool {
  return typeof value === 'object' && value !== null && definedTools.has(value);
}

function fail(problem: string, fix: string): never {
  throw new Error(`defineTool: ${problem}. ${fix}`);
}

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  const candidate = value as { safeParse?: unknown; _def?: unknown } | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.safeParse === 'function' &&
    typeof candidate._def === 'object'
  );
}

function assertValidOptions(opts: Partial<DefineToolOptions<z.ZodTypeAny, unknown>>): void {
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
  if (!isZodSchema(input)) {
    fail(
      `tool '${name}' needs a zod schema as 'input'`,
      `Import { z } from 'zod' and pass e.g. input: z.object({ query: z.string() })`
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
 * ```
 */
export function defineTool<S extends z.ZodTypeAny, R>(
  opts: DefineToolOptions<S, R>
): DefinedTool<S, Awaited<R>> {
  assertValidOptions(opts);

  const execute = async (args: z.output<S>, ctx: ToolExecutionContext): Promise<Awaited<R>> =>
    await opts.execute(args, ctx);
  // legacy (.tool): the `ai` v4 Tool shape. Removed in D26.
  const legacyTool = legacyAiTool(opts.description, opts.input, execute as NonNullable<ToolDescriptor['execute']>);
  const defined: DefinedTool<S, Awaited<R>> = {
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
    injectStreamingController: opts.injectStreamingController,
    ...(opts.annotations ? { metadata: { mcp: { annotations: opts.annotations } } } : {}),
  };
  definedTools.add(defined);
  return defined;
}
