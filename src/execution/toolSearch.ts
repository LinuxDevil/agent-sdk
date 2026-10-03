/**
 * N2: tool search. Tools marked `deferLoading` (by `defineTool()` or by an MCP
 * server with `deferLoading: true`) are not sent to the model until it finds
 * them with the built-in `tool_search` tool.
 *
 * - When a run starts (and when a handoff switches agents), `withToolSearch()`
 *   decides whether deferral applies: some tools are deferred, `toolSearch` is
 *   not `false`, and their definitions reach `thresholdPercent` of the model's
 *   context window. Then it registers `tool_search` and adds one paragraph to
 *   the system prompt.
 * - Each model call sends the non-deferred tools, the deferred tools loaded so
 *   far, and `tool_search` while some deferred tool is not loaded
 *   (`visibleTools()`, from the transcript at that call).
 * - "Loaded" is derived from the transcript, not stored: a tool is loaded when
 *   a successful `tool_search` result after the last handoff names it. So it
 *   survives a crash resume, an approval pause and a fork with no new state; a
 *   compaction that prunes the result unloads the tools; and a handoff target
 *   starts with nothing loaded.
 */

import { z } from 'zod';
import type { ToolDefinition } from '../providers';
import type { AgentConfig, ToolDescriptor } from '../types';
import type { ToolRegistry } from '../tools';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { toolFailure } from '../tools/built-in/toolFailure';
import { rankToolsByKeywords, type SearchableTool } from '../tools/toolSearchRank';
import { withPromptTool } from '../skills/withSkills';
import { estimateTokens } from '../models/estimateTokens';
import { getModelInfo } from '../models/registry';
import { schemaToJsonSchema } from '../utils/zodCompat';
import { zodSchema } from 'ai';
import { ConfigurationError } from './errors';
import { buildTools } from './generateStep';
import type { ExecuteOptions } from './AgentExecutor';
import { TOOL_SEARCH_TOOL, loadedToolNames, type ToolDeferral } from './toolDeferral';


/** Built-in tools that are never deferred, whatever their descriptor says. */
const NEVER_DEFERRED = new Set(['load_skill', 'task', 'ask_question', TOOL_SEARCH_TOOL]);

const DEFAULT_THRESHOLD_PERCENT = 0.1;
const DEFAULT_MAX_RESULTS = 5;
/** The context window when neither `toolSearch.contextWindow` nor the model registry knows it (as compaction). */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Tuning of tool search (`createAgent({ toolSearch })`, `ExecuteOptions.toolSearch`).
 * Deferral itself is turned on by marking tools or MCP servers `deferLoading`.
 * See docs/tool-search.md.
 */
export interface ToolSearchOptions {
  /** Defer only when the deferred definitions reach this share of the context window. Default 0.1 (10%). 0 always defers. */
  thresholdPercent?: number;
  /** Tools loaded per search. Default 5. */
  maxResults?: number;
  /** The model's context window; default: the model registry, else 128,000. */
  contextWindow?: number;
  /** Custom ranking: return tool names, best first. Unknown names and duplicates are dropped. */
  search?: (query: string, tools: ReadonlyArray<{ name: string; description: string }>) => string[] | Promise<string[]>;
}

/** What a `tool_search` call returns (as JSON in the transcript). */
export interface ToolSearchResult {
  /** The tools found by this search; the model can call them from its next step. */
  loaded: Array<{ name: string; description: string }>;
  /** How many deferred tools are still not loaded. */
  more: number;
}

/** Throws `LOUSHO_CONFIG_INVALID` when `value` is not a valid `toolSearch` option. */
export function assertToolSearchOptions(value: unknown, where: string): void {
  if (value === undefined || value === false) return;
  const fail = (problem: string): never => {
    throw new ConfigurationError(`${where}: ${problem}. See docs/tool-search.md.`, 'toolSearch');
  };
  if (typeof value !== 'object' || value === null) fail(`'toolSearch' must be false or an object, got ${String(value)}`);
  const { thresholdPercent, maxResults, contextWindow, search } = value as ToolSearchOptions;
  if (thresholdPercent !== undefined && !(typeof thresholdPercent === 'number' && thresholdPercent >= 0 && thresholdPercent <= 1)) {
    fail(`'toolSearch.thresholdPercent' must be a number from 0 to 1, got ${String(thresholdPercent)}`);
  }
  if (maxResults !== undefined && !(Number.isInteger(maxResults) && maxResults >= 1)) {
    fail(`'toolSearch.maxResults' must be a whole number >= 1, got ${String(maxResults)}`);
  }
  if (contextWindow !== undefined && !(typeof contextWindow === 'number' && contextWindow > 0 && Number.isFinite(contextWindow))) {
    fail(`'toolSearch.contextWindow' must be a positive number, got ${String(contextWindow)}`);
  }
  if (search !== undefined && typeof search !== 'function') fail(`'toolSearch.search' must be a function`);
}

/** Whether the tool `name` (with `descriptor`) is deferred. */
function isDeferred(name: string, descriptor: ToolDescriptor | undefined): boolean {
  return descriptor?.deferLoading === true && !NEVER_DEFERRED.has(name);
}

/** A tool's input schema as JSON Schema, for the token estimate (N14: and `run_code`'s signatures); `{}` when it cannot be converted. */
export function jsonSchemaOf(parameters: unknown): unknown {
  try {
    return schemaToJsonSchema(parameters) ?? zodSchema(parameters as never).jsonSchema;
  } catch {
    // A plain JSON Schema object (or something no converter reads) is estimated as it is.
    return parameters ?? {};
  }
}

/** The estimated tokens of the definitions, as the provider would send them. */
function definitionTokens(definitions: readonly ToolDefinition[], model: string | undefined): number {
  const json = JSON.stringify(
    definitions.map(({ function: fn }) => ({ name: fn.name, description: fn.description, parameters: jsonSchemaOf(fn.parameters) }))
  );
  return estimateTokens(json, { model });
}

/** The model a run's calls are made with (as `generateStep.ts` resolves it). */
function modelOf(options: ExecuteOptions, agent: AgentConfig): string | undefined {
  return agent.settings?.model || options.provider.defaultModel;
}

/** The system-prompt paragraph of an agent with deferred tools. */
function promptBlock(definitions: readonly ToolDefinition[], registry: ToolRegistry | undefined): string {
  const servers = new Map<string, number>();
  let others = 0;
  for (const { function: fn } of definitions) {
    const server = registry?.get(fn.name)?.metadata?.mcp?.server;
    if (server) servers.set(server, (servers.get(server) ?? 0) + 1);
    else others++;
  }
  const sources = [
    ...[...servers].map(([server, count]) => `${count} from the MCP server '${server}'`),
    ...(others > 0 ? [`${others} other${others === 1 ? '' : 's'}`] : []),
  ];
  const total = definitions.length;
  const from = servers.size > 0 ? ` (${sources.join(', ')})` : '';
  return [
    '## Tool search',
    '',
    `${total} more tool${total === 1 ? ' is' : 's are'} available but not loaded yet${from}. ` +
      `To find one, call \`${TOOL_SEARCH_TOOL}\` with a few words describing the capability you need; the tools it finds can be called from your next step.`,
  ].join('\n');
}

/** The `tool_search` tool over `tools` (the deferred ones). */
function createToolSearchTool(tools: readonly SearchableTool[], deferral: ToolDeferral, settings: ToolSearchOptions): DefinedTool {
  const maxResults = settings.maxResults ?? DEFAULT_MAX_RESULTS;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const rank = async (query: string): Promise<string[]> => {
    if (!settings.search) return rankToolsByKeywords(query, tools);
    try {
      return await settings.search(query, tools);
    } catch (error) {
      throw toolFailure(`${TOOL_SEARCH_TOOL} failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  };
  return defineTool({
    name: TOOL_SEARCH_TOOL,
    description:
      'Search for more tools by what they do. Returns the matching tools (name and description); call them from your next step. ' +
      'Use a few words describing the capability you need, e.g. "currency conversion".',
    input: z.object({ query: z.string().describe('A few words describing the capability you need') }),
    // N4: searching changes nothing, so plan mode can use it.
    annotations: { readOnlyHint: true, destructiveHint: false },
    execute: async ({ query }, ctx): Promise<ToolSearchResult> => {
      const ranked = await rank(query);
      const names = [...new Set(Array.isArray(ranked) ? ranked : [])].filter((name) => typeof name === 'string' && byName.has(name)).slice(0, maxResults);
      const loaded = loadedToolNames(ctx.messages, deferral.deferred);
      for (const name of names) loaded.add(name);
      return {
        loaded: names.map((name) => byName.get(name) as SearchableTool),
        more: deferral.deferred.size - loaded.size,
      };
    },
  });
}

/**
 * Applies tool search to an agent run: when some of its tools are deferred and
 * the deferral is worth it (see the file comment), registers `tool_search`,
 * adds the prompt paragraph and returns the deferral. Otherwise the inputs as
 * they are. Throws `LOUSHO_CONFIG_INVALID` for an invalid `toolSearch`, or when
 * deferral applies and a tool is already called `tool_search`.
 */
export function withToolSearch(
  options: ExecuteOptions,
  agent: AgentConfig,
  toolRegistry: ToolRegistry | undefined
): { agent: AgentConfig; toolRegistry: ToolRegistry | undefined; deferral?: ToolDeferral } {
  const settings = options.toolSearch;
  if (settings === false) return { agent, toolRegistry };
  assertToolSearchOptions(settings, 'toolSearch');
  const definitions = buildTools(agent, toolRegistry).filter(({ function: { name } }) => isDeferred(name, toolRegistry?.get(name)));
  if (definitions.length === 0) return { agent, toolRegistry };
  const model = modelOf(options, agent);
  const contextWindow = settings?.contextWindow ?? (model ? getModelInfo(model)?.contextWindow : undefined) ?? FALLBACK_CONTEXT_WINDOW;
  const thresholdPercent = settings?.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
  // Below the threshold there is nothing to gain: every tool loads upfront.
  if (thresholdPercent > 0 && definitionTokens(definitions, model) < thresholdPercent * contextWindow) return { agent, toolRegistry };
  if (toolRegistry?.has(TOOL_SEARCH_TOOL) || agent.tools?.[TOOL_SEARCH_TOOL]) {
    throw new ConfigurationError(
      `Agent '${agent.name}': a tool named '${TOOL_SEARCH_TOOL}' is already registered, but agents with deferred tools get one automatically. ` +
        `Rename your tool, or set toolSearch: false.`,
      'toolSearch'
    );
  }
  const deferral: ToolDeferral = { deferred: new Set(definitions.map(({ function: fn }) => fn.name)) };
  const searchable = definitions.map(({ function: fn }) => ({ name: fn.name, description: fn.description }));
  const tool = createToolSearchTool(searchable, deferral, settings ?? {});
  return { ...withPromptTool(agent, toolRegistry, tool, promptBlock(definitions, toolRegistry)), deferral };
}
