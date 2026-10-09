/**
 * MCP Tool Loader (LOU-F2 / LOU-F3 / LOU-Z1 / LOU-Z2)
 *
 * Loads tools advertised by a remote MCP server (via an already-connected
 * `Client` from `@modelcontextprotocol/sdk`) and turns them into raw MCP
 * tool descriptions (listRemoteTools) or SDK tool descriptors (loadMcpTools).
 */

import type { McpToolAnnotations, NamedToolDescriptor, ToolDescriptor } from '../../types';
import { noopLogger, type Logger } from '../../execution/logger';
import { handleCallToolResult } from './result';
import { z, type ZodTypeAny } from 'zod';
import { jsonSchemaToZod } from './schema';
import { toolDescriptorFromSchema } from '../toolContract';

/**
 * Minimal shape of a tool as returned by an MCP server's `tools/list`
 * response. The SDK's `Client.listTools()` return type is structurally
 * compatible with this (it returns a more precisely-typed inline object),
 * but doesn't export a standalone named type for a single tool entry, so
 * we define our own minimal one here rather than depend on an unexported
 * internal type.
 */
export interface RawMcpTool {
  name: string;
  description?: string;
  inputSchema: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  /** The server's `ToolAnnotations` (hints), when it sends any (LOU-Z5). */
  annotations?: McpToolAnnotations;
}

/**
 * Which MCP tools ask for approval (LOU-Z5). `'always'` (default, Eve TOOLS-F11)
 * asks for every tool: a server's hints are its own word, not a guarantee.
 * `'annotations'` opts in to trusting them: `readOnlyHint: true` runs (and may run
 * in plan mode), `destructiveHint` true or absent (the MCP spec's default) asks,
 * `destructiveHint: false` runs. `'never'` asks for no tool. A function decides per
 * call from the tool's bare name, its annotations (`{}` when it sent none) and the
 * call's `args`.
 */
export type McpApproval =
  | 'annotations'
  | 'always'
  | 'never'
  | ((tool: { name: string; annotations: McpToolAnnotations; args?: Record<string, unknown> }) => boolean);

function needsApproval(approval: McpApproval, name: string, annotations: McpToolAnnotations = {}): ToolDescriptor['needsApproval'] {
  if (approval === 'always') return true;
  if (approval === 'never') return false;
  if (typeof approval === 'function') return (args: unknown) => approval({ name, annotations, args: args as Record<string, unknown> });
  return annotations.readOnlyHint !== true && annotations.destructiveHint !== false;
}

/** Which of a server's tools to load, by their bare MCP names. */
export interface McpToolFilter {
  /** Load only these tools. */
  include?: readonly string[];
  /** Leave these tools out (applied after `include`). */
  exclude?: readonly string[];
}

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const TOOL_NAME_MAX = 64;

/** A short, stable hash of `text` (FNV-1a), to keep shortened names distinct. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The name the model calls an MCP tool by: `<server>__<tool>` with characters
 * outside `[a-zA-Z0-9_-]` replaced by `_`, cut to 64 characters (with a hash of
 * the original name, so cut names stay distinct). A valid name is unchanged.
 */
function modelToolName(server: string, tool: string, taken: Set<string>): string {
  const raw = `${server}__${tool}`;
  let name = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (name.length > TOOL_NAME_MAX) name = `${name.slice(0, TOOL_NAME_MAX - 9)}_${shortHash(raw)}`;
  for (let n = 2; taken.has(name); n++) {
    const suffix = `_${n}`;
    name = `${name.slice(0, TOOL_NAME_MAX - suffix.length)}${suffix}`;
  }
  return name;
}

/**
 * The part of an `@modelcontextprotocol/sdk` `Client` the loader uses: a
 * connected `Client`, or a stand-in that connects on demand (see `connectMcp()`).
 * Declared structurally rather than `Pick<Client, 'listTools' | 'callTool'>` so
 * the published declarations do not import the optional `@modelcontextprotocol/sdk`
 * peer - a consumer without it installed would get TS2307 inside the SDK's own
 * `.d.ts` under `skipLibCheck: false`. A real `Client` satisfies this shape.
 */
export interface McpClientLike {
  /** `client.listTools()`: one page of the tools the server advertises (`response.tools`, then `nextCursor`). */
  listTools(params?: { cursor?: string }, options?: unknown): Promise<{ tools: RawMcpTool[]; nextCursor?: string }>;
  /** `client.callTool()`: the raw result, handled by {@link handleCallToolResult}. */
  callTool(params: { name: string; arguments?: Record<string, unknown> }, resultSchema?: unknown, options?: unknown): Promise<unknown>;
}

/** Eve TOOLS-F18: the most `tools/list` pages read from one server. */
const MAX_MCP_TOOL_PAGES = 100;

/**
 * List the tools a connected MCP client's server advertises, following
 * `nextCursor` through every page (Eve TOOLS-F18), up to
 * 100 pages; a server that sends more, or repeats a
 * cursor, is cut off there with a warning through `options.logger`.
 *
 * It deliberately does NOT catch/wrap connection errors: a `listTools()`
 * rejection (e.g. the client isn't connected, or the transport drops)
 * propagates straight out to the caller.
 */
export async function listRemoteTools(client: McpClientLike, options: { logger?: Logger; server?: string } = {}): Promise<RawMcpTool[]> {
  const { logger = noopLogger, server = 'MCP server' } = options;
  const tools: RawMcpTool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MCP_TOOL_PAGES; page++) {
    const response = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...response.tools);
    cursor = response.nextCursor;
    if (cursor === undefined || cursor === '') return tools;
    if (seen.has(cursor)) {
      logger.warn(`${server}: tools/list repeated the cursor '${cursor}'; stopped after ${page + 1} pages`, { server, cursor });
      return tools;
    }
    seen.add(cursor);
  }
  logger.warn(`${server}: tools/list has more than ${MAX_MCP_TOOL_PAGES} pages; loaded the first ${MAX_MCP_TOOL_PAGES}`, { server });
  return tools;
}

/** A tool that {@link loadMcpTools} could not load. */
export interface SkippedMcpTool {
  /** The bare MCP tool name (not namespaced). */
  name: string;
  /** Why the tool was skipped. */
  reason: string;
}

/** Options for {@link loadMcpTools}. */
export interface LoadMcpToolsOptions {
  /**
   * Receives a warning for every tool that is skipped (naming the server,
   * the tool and the reason). Defaults to a no-op logger.
   */
  logger?: Logger;
  /** Called once per skipped tool, so callers can surface what was left out. */
  onSkip?: (skipped: SkippedMcpTool) => void;
  /** Which tools ask for approval; see {@link McpApproval}. Default `'always'`. */
  approval?: McpApproval;
  /** N2: mark every tool `deferLoading`, so an agent offers them through `tool_search` (docs/tool-search.md). */
  deferLoading?: boolean;
  /**
   * How long one tool call may take, in milliseconds, before it fails with a
   * timeout error. Default: the MCP SDK's 60 seconds. The run's abort signal
   * also cancels a call in flight.
   */
  timeoutMs?: number;
  /** Load only some of the server's tools; see {@link McpToolFilter}. */
  tools?: McpToolFilter;
}

/**
 * Load a connected MCP client's tools and synthesize a ToolDescriptor for
 * each one, keyed by `${connectionName}__${tool.name}` so tools from
 * different MCP connections can never collide even if they share a bare
 * name (e.g. two servers both exposing a `search` tool). A key that is not
 * a valid model tool name (`^[a-zA-Z0-9_-]{1,64}$`) is sanitized; the
 * original name stays in `metadata.mcp.tool`.
 *
 * Each synthesized descriptor's `execute` calls back through
 * `client.callTool({ name: tool.name, arguments: args })` - the *raw*
 * MCP tool name, not the namespaced key - since that's what the remote
 * server actually knows about.
 *
 * A tool whose schema cannot be converted is skipped (warned through
 * `options.logger`, reported to `options.onSkip`) and never prevents the
 * server's other tools from loading. Tools ask for approval per `options.approval` (by default
 * every tool asks; `'annotations'` trusts the server's hints). Results with `isError: true` throw an
 * {@link McpToolError}; other results keep text, structured and media
 * content (see {@link handleCallToolResult}).
 *
 * @example
 * const skipped: SkippedMcpTool[] = [];
 * const tools = await loadMcpTools(client, 'github', {
 *   logger: console,
 *   onSkip: (s) => skipped.push(s),
 * });
 */
export async function loadMcpTools(
  client: McpClientLike,
  connectionName: string,
  options: LoadMcpToolsOptions = {}
): Promise<Record<string, NamedToolDescriptor>> {
  const { logger = noopLogger, onSkip, approval = 'always', deferLoading, timeoutMs, tools: filter } = options;
  const rawTools = selectTools(await listRemoteTools(client, { logger, server: `MCP server '${connectionName}'` }), connectionName, filter, logger);
  const descriptors: Record<string, NamedToolDescriptor> = {};
  const taken = new Set<string>();

  for (const rawTool of rawTools) {
    try {
      // LOU-R12: the descriptor carries its `<server>__<tool>` name, so
      // `Object.values(tools)` also works in a `tools` array.
      const name = modelToolName(connectionName, rawTool.name, taken);
      if (!TOOL_NAME_PATTERN.test(`${connectionName}__${rawTool.name}`)) {
        logger.warn(`MCP server '${connectionName}': tool '${rawTool.name}' is offered to the model as '${name}'`, {
          server: connectionName,
          tool: rawTool.name,
          name,
        });
      }
      const descriptor: NamedToolDescriptor = { ...buildDescriptor(client, rawTool, approval, connectionName, timeoutMs), name };
      descriptors[name] = deferLoading ? { ...descriptor, deferLoading: true } : descriptor;
      taken.add(name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`MCP server '${connectionName}': skipping tool '${rawTool.name}': ${reason}`, {
        server: connectionName,
        tool: rawTool.name,
        reason,
      });
      onSkip?.({ name: rawTool.name, reason });
    }
  }

  return descriptors;
}

/** The tools `filter` keeps; warns about `include` names the server does not have. */
function selectTools(rawTools: RawMcpTool[], server: string, filter: McpToolFilter | undefined, logger: Logger): RawMcpTool[] {
  if (!filter) return rawTools;
  const { include, exclude } = filter;
  for (const name of include ?? []) {
    if (!rawTools.some((tool) => tool.name === name)) {
      logger.warn(`MCP server '${server}': tools.include names '${name}', which the server does not offer`, { server, tool: name });
    }
  }
  return rawTools.filter((tool) => (!include || include.includes(tool.name)) && !exclude?.includes(tool.name));
}

/** The MCP SDK's `RequestOptions` of one call: the run's signal and the server's timeout, when set. */
function callOptions(signal: AbortSignal | undefined, timeoutMs: number | undefined): { signal?: AbortSignal; timeout?: number } {
  return { ...(signal && { signal }), ...(timeoutMs !== undefined && { timeout: timeoutMs }) };
}

/**
 * Providers require a tool's argument schema to be an object. A root that
 * converts to anything else (a union, `z.any()`) becomes a passthrough
 * object so the tool still loads and the server validates (Eve TOOLS-F4).
 */
function objectRoot(schema: ZodTypeAny): ZodTypeAny {
  return schema instanceof z.ZodObject ? schema : z.object({}).passthrough();
}

function buildDescriptor(
  client: McpClientLike,
  rawTool: RawMcpTool,
  approval: McpApproval,
  server: string,
  timeoutMs: number | undefined
): ToolDescriptor {
  return toolDescriptorFromSchema({
    displayName: rawTool.annotations?.title || rawTool.description || rawTool.name,
    description: rawTool.description || '',
    inputSchema: objectRoot(jsonSchemaToZod(rawTool.inputSchema)),
    needsApproval: needsApproval(approval, rawTool.name, rawTool.annotations),
    // Eve TOOLS-F11: plan mode trusts the server's `readOnlyHint` only when `approval` does.
    metadata: { mcp: { annotations: rawTool.annotations, server, tool: rawTool.name, ...(approval !== 'annotations' && { annotationsTrusted: false }) } },
    execute: async (args, ctx) =>
      handleCallToolResult(
        await client.callTool({ name: rawTool.name, arguments: args }, undefined, callOptions(ctx?.abortSignal, timeoutMs)),
        rawTool.name
      ),
  });
}
