/**
 * Tool-name helpers for calls whose name does not match a registered tool:
 * prefixes models add (`functions.read_file`) and the not-found message.
 */

import type { ToolCall } from '../providers';
import { closestMatch } from '../utils/closestMatch';

/** Namespaces some models put in front of a tool name. */
const MODEL_PREFIXES = ['functions.', 'tools.', 'default_api.'];

/**
 * The registered tool a model meant: `name` itself when it is known, else
 * `name` with one model-added prefix stripped when that is a known tool.
 */
export function resolveToolName(name: string, known: ReadonlySet<string>): string {
  if (known.has(name)) return name;
  const prefix = MODEL_PREFIXES.find((p) => name.startsWith(p) && known.has(name.slice(p.length)));
  return prefix ? name.slice(prefix.length) : name;
}

/**
 * The calls with prefixed names resolved (see {@link resolveToolName}), so
 * permission rules, hooks, events and the history all see the real name.
 * Calls that need no change are returned as they are.
 */
export function resolveToolCallNames(toolCalls: ToolCall[] | undefined, known: ReadonlySet<string>): ToolCall[] | undefined {
  if (!toolCalls?.some((call) => resolveToolName(call.function.name, known) !== call.function.name)) return toolCalls;
  return toolCalls.map((call) => {
    const name = resolveToolName(call.function.name, known);
    return name === call.function.name ? call : { ...call, function: { ...call.function, name } };
  });
}

/** How many tool names a not-found message lists. */
const LISTED_TOOLS = 20;

/** `Tool 'read-file' not found. Did you mean 'read_file'? Available tools: ...` */
export function toolNotFoundMessage(name: string, available: readonly string[]): string {
  const base = `Tool '${name}' not found`;
  if (available.length === 0) return base;
  const suggestion = closestMatch(name, available);
  const listed = available.slice(0, LISTED_TOOLS).join(', ') + (available.length > LISTED_TOOLS ? `, ... (${available.length} tools)` : '');
  return `${base}.${suggestion ? ` Did you mean '${suggestion}'?` : ''} Available tools: ${listed}`;
}
