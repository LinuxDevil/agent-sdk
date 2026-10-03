/**
 * N2: the per-step half of tool search, kept apart from `toolSearch.ts` so the
 * request builder (`generateStep.ts`) does not import the tool search setup:
 * which deferred tools the transcript has loaded, and which tools a model
 * call is sent. See `toolSearch.ts` for the whole picture.
 */

import type { Message, ToolDefinition } from '../providers';
import type { ExecuteOptions } from './AgentExecutor';
import type { ToolSearchResult } from './toolSearch';

/** The name of the built-in tool search tool. */
export const TOOL_SEARCH_TOOL = 'tool_search';

/** The deferral of one agent's run: which tools are withheld. */
export interface ToolDeferral {
  /** Names of the deferred tools. */
  deferred: ReadonlySet<string>;
}

/** Where a run's deferral rides on its options (set by `withExtensions()` for the active agent). */
const TOOL_DEFERRAL: unique symbol = Symbol('lousho.toolDeferral');

type DeferringOptions = ExecuteOptions & { [TOOL_DEFERRAL]?: ToolDeferral };

/** The deferral of the agent `options` run, if tool search is active for it. */
export function deferralOf(options: ExecuteOptions): ToolDeferral | undefined {
  return (options as DeferringOptions)[TOOL_DEFERRAL];
}

/** `options` (a run's own copy) with the active agent's deferral set - also to `undefined`, so a handoff target never keeps the lead's. */
export function withDeferral(options: ExecuteOptions, deferral: ToolDeferral | undefined): ExecuteOptions {
  (options as DeferringOptions)[TOOL_DEFERRAL] = deferral;
  return options;
}

/** The deferred tools a `tool_search` result message names, if it is a successful one. */
function resultNames(message: Message): string[] {
  if (message.role !== 'tool' || (message.toolName ?? message.name) !== TOOL_SEARCH_TOOL || message.isError) return [];
  if (typeof message.content !== 'string') return [];
  try {
    const parsed = JSON.parse(message.content) as Partial<ToolSearchResult> | null;
    if (!parsed || !Array.isArray(parsed.loaded)) return [];
    return parsed.loaded.flatMap((tool) => (typeof tool?.name === 'string' ? [tool.name] : []));
  } catch {
    // Replaced by a compaction (or a hook) with something else: it loads nothing.
    return [];
  }
}

/**
 * The deferred tools loaded in `messages`: named by a successful `tool_search`
 * result after the last handoff marker (a handoff target starts with none).
 */
export function loadedToolNames(messages: readonly Message[], deferred: ReadonlySet<string>): Set<string> {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].metadata?.handoff !== undefined) {
      start = i;
      break;
    }
  }
  const loaded = new Set<string>();
  for (const message of messages.slice(start)) {
    for (const name of resultNames(message)) if (deferred.has(name)) loaded.add(name);
  }
  return loaded;
}

/**
 * The tools sent on a model call: every tool of `all` that is not deferred,
 * the deferred ones loaded in `messages`, and `tool_search` while some
 * deferred tool is not loaded. Without a deferral, `all`.
 */
export function visibleTools(all: ToolDefinition[], messages: readonly Message[], deferral: ToolDeferral | undefined): ToolDefinition[] {
  if (!deferral) return all;
  const loaded = loadedToolNames(messages, deferral.deferred);
  const allLoaded = loaded.size >= deferral.deferred.size;
  return all.filter(({ function: { name } }) => {
    if (name === TOOL_SEARCH_TOOL) return !allLoaded;
    return !deferral.deferred.has(name) || loaded.has(name);
  });
}
