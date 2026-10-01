/**
 * Pure helpers for `serveMcp`. Kept apart from `buildServer` so that importing
 * `serveMcp` does not load `@modelcontextprotocol/sdk` (it is loaded on first
 * `serveMcp()` call, LOU-D19).
 */
import type { McpToolAnnotations } from '../../../types';
import type { DefinedTool } from '../../defineTool';

const TOOL_NAME_MAX = 64;

/** Turns a server name into a valid MCP tool name (`[A-Za-z0-9_-]`, at most 64 characters). */
export function sanitizeToolName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, TOOL_NAME_MAX) || 'agent';
}

/** True when a tool pauses for a human before running (a flag or a predicate). */
export function needsApprovalGate(tool: DefinedTool): boolean {
  return tool.needsApproval !== undefined && tool.needsApproval !== false;
}

/**
 * MCP annotations to advertise for a tool: its own `annotations` (verbatim), over
 * `destructiveHint: true` when it needs approval. A tool that needs approval is never
 * read-only. `undefined` when there is nothing to say, so an unannotated tool keeps
 * the client's default (asks for approval).
 */
export function toolAnnotations(tool: DefinedTool): McpToolAnnotations | undefined {
  const own = tool.metadata?.mcp?.annotations;
  if (!needsApprovalGate(tool)) return own;
  return { destructiveHint: true, ...own, readOnlyHint: false };
}
