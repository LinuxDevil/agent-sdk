import type { Tool as AITool } from 'ai'; // legacy (.tool), removed in D26
import type { StandardSchemaV1 } from '../utils/zodCompat';
import type { RunUsage } from '../models/usage';
import type { Message } from '../providers/llm';
import { SandboxAdapter } from '../security/sandboxCore';

/**
 * Tool parameter definition
 */
export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
}

/**
 * Tool parameters schema
 */
export interface ToolParameters {
  type: string;
  properties: Record<string, ToolParameter>;
  required: string[];
}

/**
 * Tool configuration for agents
 */
export interface ToolConfiguration {
  tool: string;
  description?: string;
  options?: Record<string, any>;
}

/**
 * The second argument of a tool's `execute(args, ctx)`: what the SDK tells
 * a tool about the call it is running. The same object reaches `defineTool`'s
 * `execute`, `ToolDescriptor.execute` and `sandboxExecute`, on every path
 * that runs a tool (main loop, resume after an approval, sandbox, flow node).
 * Structurally it stays assignable from the `ai` SDK's own execute options.
 */
export interface ToolExecutionContext {
  /**
   * The model's id for this tool call. It stays the same when a call that
   * was running when the process died is re-run on resume, so a tool can use
   * it as an idempotency key (LOU-U9).
   */
  toolCallId: string;
  /** A read-only copy of the transcript the model had seen before it made this call. */
  messages: readonly Message[];
  /** The run's cancellation signal, set when the run has one. */
  abortSignal?: AbortSignal;
  /** The session the run belongs to, when it has one. */
  sessionId?: string;
  /** Called by the delegate tool with a finished child run's usage, so the parent run adds it to its totals (LOU-V5). */
  onDelegatedUsage?: (usage: RunUsage) => void;
  /**
   * Set when the call runs because a human approved it (`resumeAfterApproval()`,
   * `agent.approvals.resolve()`): the decision's `note`. For the built-in
   * `ask_question` tool it is the user's answer (LOU-X9).
   */
  approval?: { note?: string };
}

/**
 * Tool descriptor with display name
 */
/** An MCP server's `ToolAnnotations` for a tool: hints, not guarantees (LOU-Z5). */
export interface McpToolAnnotations {
  title?: string;
  /** The tool does not change its environment. */
  readOnlyHint?: boolean;
  /** The tool may destroy or overwrite data (the MCP spec's default when absent). */
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Extra facts about a tool; `mcp` is set on tools loaded from an MCP server (LOU-Z5). */
export interface ToolMetadata {
  mcp?: {
    /** The server's raw annotations for this tool, when it sent any. */
    annotations?: McpToolAnnotations;
  };
}

/**
 * What a tool's `needsApproval` function decides for one call (LOU-X8):
 * `'ask'` (or `true`) pauses for approval, `'approve'` (or `false`) runs the
 * call, `'deny'` or `{ deny: reason }` does not run it and gives the model a
 * `kind: 'denied'` tool error with the reason.
 */
export type ApprovalOutcome = boolean | 'approve' | 'deny' | 'ask' | { deny: string };

/** The second argument of a `needsApproval` function (LOU-X8): the call being checked. */
export interface ApprovalCheckContext {
  toolName: string;
  toolCallId: string;
  sessionId?: string;
  /** The run's transcript so far, including earlier turns of a session. */
  messages: readonly Message[];
}

export interface ToolDescriptor {
  displayName: string;
  /**
   * Schema of the tool's arguments (zod 3, zod 4 or a Standard Schema that
   * exposes its JSON Schema; LOU-D29). Canonical: when set, it is used
   * instead of `tool.parameters` for argument validation and the schema
   * sent to the model (LOU-D22). {@link defineTool} sets it.
   */
  inputSchema?: StandardSchemaV1;
  /**
   * Runs the tool. Canonical: when set, it is called instead of
   * `tool.execute` (LOU-D22). {@link defineTool} sets it.
   */
  execute?(args: unknown, ctx: ToolExecutionContext): unknown;
  /**
   * Legacy: an `ai` v4 `Tool` (`{ description, parameters, execute }`),
   * kept for compatibility this release. Prefer `inputSchema` and `execute`.
   */
  tool: AITool;
  needsApproval?: boolean | ((args: any, ctx: ApprovalCheckContext) => ApprovalOutcome | Promise<ApprovalOutcome>);
  /** Where the tool came from, e.g. an MCP server's annotations (LOU-Z5). */
  metadata?: ToolMetadata;
  /**
   * @deprecated LOU-D41: never called by the SDK (no supported path reaches
   * it); it will be removed.
   */
  injectStreamingController?: (controller: ReadableStreamDefaultController<unknown>) => void;
  /**
   * When true, AgentExecutor routes this tool's execution through the
   * configured SandboxAdapter (see ExecuteOptions.sandbox, LOU-F5) instead
   * of calling `tool.execute()` directly. Defaults to false/undefined,
   * which is the exact pre-existing, unchanged execution path.
   */
  requiresSandbox?: boolean;
  /**
   * Explicit alternate execution path a tool author implements when they
   * want their tool to be genuinely sandboxable (LOU-F fix). Receives the
   * configured SandboxAdapter and is responsible for using
   * `sandbox.run()`/`sandbox.writeFile()` itself to perform the tool's
   * real work (e.g. writing input to a file, running a command that does
   * the actual computation, parsing the command's stdout as the result).
   *
   * This is the tool author's contract for "how do I actually run inside
   * a sandbox" - a generic bridge from an arbitrary in-process JS closure
   * (`tool.execute`) to a subprocess isn't mechanically possible without
   * the tool itself cooperating. When `requiresSandbox` is true,
   * AgentExecutor requires this to be defined and calls it instead of
   * `tool.execute()`; if it is missing, AgentExecutor throws rather than
   * silently falling back to unsandboxed in-process execution.
   *
   * LOU-U15: the third argument is the same execute context
   * `tool.execute()` receives (a {@link ToolExecutionContext}).
   * It is optional to declare: an implementation that takes only
   * `(args, sandbox)` keeps working.
   */
  sandboxExecute?: (
    args: unknown,
    sandbox: SandboxAdapter,
    ctx?: ToolExecutionContext
  ) => Promise<unknown>;
}

/**
 * Tool registry interface
 */
export interface IToolRegistry {
  register(name: string, descriptor: ToolDescriptor): void;
  get(name: string): ToolDescriptor | undefined;
  has(name: string): boolean;
  list(): string[];
  clear(): void;
}
