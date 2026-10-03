/**
 * LOU-R12: `createAgent({ tools })` and `ToolRegistry.registerMany()` accept
 * tools as a record keyed by name, as an array of named tools, or as an
 * array mixing named tools and records (e.g. `[mcp.tools, weatherTool]` or
 * `[...Object.values(mcp.tools), weatherTool]`). Every shape is flattened
 * here to `[name, tool]` entries, the one form the registry code works with.
 */

import type { HostedTool } from './hosted';
import { isHostedTool } from './hosted';
import { isDefinedTool, type DefinedTool } from './defineTool';
import type { NamedToolDescriptor, ToolDescriptor } from '../types';
import { ConfigurationError } from '../execution/errors';

/**
 * One entry of a `tools` array: a named tool (`defineTool()` result, a
 * hosted tool, a {@link NamedToolDescriptor} like the ones `connectMcp()`
 * loads), or a record of tools keyed by name that is merged in place.
 */
export type ToolArrayEntry = DefinedTool | NamedToolDescriptor | HostedTool | Record<string, ToolDescriptor | HostedTool>;

/** The `tools` option's shapes: a record keyed by name, or an array of {@link ToolArrayEntry}. */
export type ToolsOption = ReadonlyArray<ToolArrayEntry> | Record<string, ToolDescriptor | HostedTool>;

/** Fields a {@link ToolDescriptor} may carry; a `tools` array entry having one is treated as a descriptor, not a record of tools. */
const DESCRIPTOR_KEYS = ['tool', 'execute', 'inputSchema', 'displayName', 'needsApproval', 'requiresSandbox', 'sandboxExecute'] as const;

/** Whether `value` looks like a {@link ToolDescriptor} rather than a record of tools. */
function looksLikeDescriptor(value: unknown): value is ToolDescriptor {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && DESCRIPTOR_KEYS.some((key) => key in value);
}

function describeEntry(entry: unknown): string {
  if (entry === null) return 'null';
  if (Array.isArray(entry)) return 'an array (put its entries in the `tools` array directly)';
  return typeof entry === 'object' ? 'an object that is not a tool or a record of tools' : typeof entry;
}

/**
 * Every tool of `tools` as `[name, tool]` entries. Record entries are keyed
 * by the record's key; array entries take the tool's own `name`
 * (`defineTool()` and hosted tools always have one; a raw descriptor needs
 * the `name` a loader like `connectMcp()` put on it).
 *
 * A duplicate name across a record key and another entry is a
 * ConfigurationError here - the record form would otherwise overwrite
 * silently. Two `defineTool()` results under their own name stay both, so
 * `ToolRegistry.registerDefined()` keeps throwing its "Tool name 'x' is
 * already registered" error that names the two tools. Hosted tools are not
 * tracked at all: `assertHostedToolNames()` owns their collisions (with a
 * local tool or another hosted tool) and its wording.
 *
 * @param caller - names the caller in error messages ('createAgent', 'ToolRegistry.registerMany').
 */
export function toolEntries(tools: ToolsOption | undefined, caller: string): Array<readonly [string, ToolDescriptor | HostedTool]> {
  if (tools === undefined) return [];
  const entries: Array<readonly [string, ToolDescriptor | HostedTool]> = [];
  // 'keyed': the name is a record key. 'defined'/'named': the tool's own name.
  const names = new Map<string, 'keyed' | 'defined' | 'named'>();
  const push = (name: string, tool: ToolDescriptor | HostedTool, keyed: boolean): void => {
    if (!isHostedTool(tool)) {
      const kind = keyed ? 'keyed' : isDefinedTool(tool) ? 'defined' : 'named';
      const previous = names.get(name);
      if (previous !== undefined && !(previous === 'defined' && kind === 'defined')) {
        throw new ConfigurationError(`${caller}: two entries in \`tools\` produce the tool name '${name}'; give one of them a different name.`, 'tools');
      }
      names.set(name, kind);
    }
    entries.push([name, tool]);
  };
  const addRecord = (record: Record<string, ToolDescriptor | HostedTool>): void => {
    for (const [key, tool] of Object.entries(record)) push(key, tool, true);
  };
  if (!Array.isArray(tools)) {
    // `Array.isArray` does not narrow the readonly-array member for TS; the union has only one other member.
    addRecord(tools as Record<string, ToolDescriptor | HostedTool>);
    return entries;
  }
  for (const entry of tools) {
    if (isHostedTool(entry) || isDefinedTool(entry)) {
      push(entry.name, entry, false);
      continue;
    }
    if (looksLikeDescriptor(entry)) {
      const { name } = entry as Partial<NamedToolDescriptor>;
      if (typeof name !== 'string' || name === '') {
        throw new ConfigurationError(
          `${caller}: a tool descriptor in the \`tools\` array has no 'name' - ` +
            'put it under its name in the record form (tools: { my_tool: descriptor }) or create the tool with defineTool().',
          'tools'
        );
      }
      push(name, entry, false);
      continue;
    }
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      addRecord(entry as Record<string, ToolDescriptor | HostedTool>);
      continue;
    }
    throw new ConfigurationError(
      `${caller}: a \`tools\` array entry must be a tool or a record of tools keyed by name, got ${describeEntry(entry)}.`,
      'tools'
    );
  }
  return entries;
}
