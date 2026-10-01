/**
 * The one place runtime code reads a tool's schema and `execute` (LOU-D22).
 * Prefers the descriptor's canonical `inputSchema` / `execute` and falls
 * back to the legacy `ai` v4 `tool.parameters` / `tool.execute`.
 */

import type { z } from 'zod';
import type { ToolDescriptor, ToolExecutionContext } from '../types';

/** A tool's `execute`, as the runtime calls it. */
type ToolExecuteFn = NonNullable<ToolDescriptor['execute']>;

/** The tool's argument schema: `inputSchema`, else the legacy `tool.parameters`. */
export function getToolInputSchema(desc: ToolDescriptor): unknown {
  return desc.inputSchema ?? (desc.tool as { parameters?: unknown } | undefined)?.parameters;
}

/** The tool's `execute`: the descriptor's own, else the legacy `tool.execute`. */
export function getToolExecute(desc: ToolDescriptor): ToolExecuteFn | undefined {
  const legacy = desc.tool?.execute as ToolExecuteFn | undefined;
  return desc.execute?.bind(desc) ?? legacy?.bind(desc.tool);
}

/** Options for {@link toolDescriptorFromSchema}. */
export interface ToolFromSchemaOptions {
  displayName: string;
  description: string;
  /** Zod schema of the arguments, e.g. one built by `jsonSchemaToZod()`. */
  inputSchema: z.ZodTypeAny;
  execute: (args: Record<string, unknown>, ctx: ToolExecutionContext) => unknown;
  /** Copied onto the descriptor as given. */
  needsApproval?: ToolDescriptor['needsApproval'];
  metadata?: ToolDescriptor['metadata'];
}

/**
 * Build a descriptor from a schema that is only known at runtime (an MCP
 * server's tool list). Unlike `defineTool` it does not validate the name or
 * require a description, since both come from a remote server. It sets the
 * canonical `inputSchema` / `execute` and a hand-built legacy `.tool` (the
 * `ai` v4 shape; `tool()` was the identity function). Removed in D26.
 */
export function toolDescriptorFromSchema(opts: ToolFromSchemaOptions): ToolDescriptor {
  const execute = async (args: unknown, ctx: ToolExecutionContext) =>
    opts.execute(args as Record<string, unknown>, ctx);
  return {
    displayName: opts.displayName,
    inputSchema: opts.inputSchema,
    execute,
    needsApproval: opts.needsApproval,
    metadata: opts.metadata,
    // legacy (.tool): the same schema and execute in the `ai` v4 shape. Removed in D26.
    tool: legacyAiTool(opts.description, opts.inputSchema, execute),
  };
}

/**
 * A hand-built legacy `.tool` in the `ai` v4 shape (`{ description,
 * parameters, execute }`; v4's `tool()` is the identity function). It is
 * typed as the installed `ai`'s `Tool`, which on `ai` v6/v7 has
 * `inputSchema` instead of `parameters`, hence the documented
 * `unknown` cast (LOU-D28a). The runtime reads `parameters` through
 * {@link getToolInputSchema} and the `execute` through {@link getToolExecute}.
 */
export function legacyAiTool(description: string, parameters: unknown, execute: ToolExecuteFn): ToolDescriptor['tool'] {
  return { description, parameters, execute } as unknown as ToolDescriptor['tool'];
}
