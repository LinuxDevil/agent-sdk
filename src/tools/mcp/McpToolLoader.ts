/**
 * MCP Tool Loader (LOU-F2 / LOU-F3 / LOU-Z1 / LOU-Z2)
 *
 * Loads tools advertised by a remote MCP server (via an already-connected
 * `Client` from `@modelcontextprotocol/sdk`) and turns them into raw MCP
 * tool descriptions (listRemoteTools) or SDK tool descriptors (loadMcpTools).
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { tool as aiTool } from 'ai';
import { ToolDescriptor } from '../../types';
import { noopLogger, type Logger } from '../../execution/logger';
import { handleCallToolResult } from './result';
import { jsonSchemaToZod } from './schema';

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
}

/**
 * The part of an `@modelcontextprotocol/sdk` `Client` the loader uses: a
 * connected `Client`, or a stand-in that connects on demand (see `connectMcp()`).
 */
export type McpClientLike = Pick<Client, 'listTools' | 'callTool'>;

/**
 * List the tools a connected MCP client's server advertises.
 *
 * This is a thin wrapper around `client.listTools()` - it returns
 * `response.tools` as-is and deliberately does NOT catch/wrap connection
 * errors: a `listTools()` rejection (e.g. the client isn't connected, or
 * the transport drops) propagates straight out to the caller.
 */
export async function listRemoteTools(client: McpClientLike): Promise<RawMcpTool[]> {
  const response = await client.listTools();
  return response.tools as unknown as RawMcpTool[];
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
}

/**
 * Load a connected MCP client's tools and synthesize a ToolDescriptor for
 * each one, keyed by `${connectionName}__${tool.name}` so tools from
 * different MCP connections can never collide even if they share a bare
 * name (e.g. two servers both exposing a `search` tool).
 *
 * Each synthesized descriptor's `execute` calls back through
 * `client.callTool({ name: tool.name, arguments: args })` - the *raw*
 * MCP tool name, not the namespaced key - since that's what the remote
 * server actually knows about.
 *
 * A tool whose schema cannot be converted is skipped (warned through
 * `options.logger`, reported to `options.onSkip`) and never prevents the
 * server's other tools from loading. Results with `isError: true` throw an
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
): Promise<Record<string, ToolDescriptor>> {
  const { logger = noopLogger, onSkip } = options;
  const rawTools = await listRemoteTools(client);
  const descriptors: Record<string, ToolDescriptor> = {};

  for (const rawTool of rawTools) {
    try {
      descriptors[`${connectionName}__${rawTool.name}`] = buildDescriptor(client, rawTool);
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

function buildDescriptor(client: McpClientLike, rawTool: RawMcpTool): ToolDescriptor {
  const parameters = jsonSchemaToZod(rawTool.inputSchema);
  return {
    displayName: rawTool.description || rawTool.name,
    tool: aiTool({
      description: rawTool.description || '',
      parameters: parameters as any,
      execute: async (args: Record<string, unknown>) =>
        handleCallToolResult(
          await client.callTool({ name: rawTool.name, arguments: args }),
          rawTool.name
        ),
    }),
  };
}
