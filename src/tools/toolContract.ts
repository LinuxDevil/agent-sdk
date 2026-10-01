/**
 * The one place runtime code reads a tool's schema and `execute` (LOU-D22).
 * Prefers the descriptor's canonical `inputSchema` / `execute` and falls
 * back to the legacy `ai` v4 `tool.parameters` / `tool.execute`.
 */

import type { ToolDescriptor } from '../types';

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
