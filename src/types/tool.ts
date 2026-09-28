import { Tool as AITool } from 'ai';

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
