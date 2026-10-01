import type { Tool as AITool, ToolExecutionOptions } from 'ai';
import type { z } from 'zod';
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
 * Tool descriptor with display name
 */
export interface ToolDescriptor {
  displayName: string;
  /**
   * Zod schema of the tool's arguments. Canonical: when set, it is used
   * instead of `tool.parameters` for argument validation and the schema
   * sent to the model (LOU-D22). {@link defineTool} sets it.
   */
  inputSchema?: z.ZodTypeAny;
  /**
   * Runs the tool. Canonical: when set, it is called instead of
   * `tool.execute` (LOU-D22). {@link defineTool} sets it.
   */
  execute?(args: unknown, ctx: ToolExecutionOptions): unknown;
  /**
   * Legacy: an `ai` v4 `Tool` (`{ description, parameters, execute }`),
   * kept for compatibility this release. Prefer `inputSchema` and `execute`.
   */
  tool: AITool;
  needsApproval?: boolean | ((args: any) => boolean | Promise<boolean>);
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
   * `tool.execute()` receives (`toolCallId`, `messages`, `abortSignal`).
   * It is optional to declare: an implementation that takes only
   * `(args, sandbox)` keeps working.
   */
  sandboxExecute?: (
    args: unknown,
    sandbox: SandboxAdapter,
    ctx?: ToolExecutionOptions
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
