/**
 * N1a/N1b: how a provider maps a hosted helper's options (`webSearch({ maxUses })`)
 * to its own tool's arguments, warning once about the options it has no field for.
 */

import type { HostedTool } from '../tools/hosted';

/** Each helper option to the provider's arguments; `undefined`: the provider has no such option. */
export type HostedOptionMapping = Record<string, ((value: unknown) => Record<string, unknown>) | undefined>;

/** `tool name: options` already warned about (once per process). */
const warnedOptions = new Set<string>();

/**
 * A helper's options as the provider's tool arguments. Options the provider
 * does not take are dropped with one `console.warn` naming `label` (e.g. "OpenAI").
 */
export function mappedHostedOptions(label: string, tool: HostedTool, mapping: HostedOptionMapping): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(tool.options)) {
    const map = mapping[key];
    if (map) Object.assign(args, map(value));
    else dropped.push(key);
  }
  const warnKey = `${label}:${tool.name}:${dropped.join(',')}`;
  if (dropped.length > 0 && !warnedOptions.has(warnKey)) {
    warnedOptions.add(warnKey);
    console.warn(`[lousho] ${label}'s ${tool.name} tool does not take ${dropped.join(', ')}; ignored.`);
  }
  return args;
}
