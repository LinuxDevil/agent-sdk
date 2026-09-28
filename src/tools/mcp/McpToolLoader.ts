/**
 * MCP Tool Loader (LOU-F2 / LOU-F3)
 *
 * Loads tools advertised by a remote MCP server (via an already-connected
 * `Client` from `@modelcontextprotocol/sdk`) and turns them into raw MCP
 * tool descriptions (listRemoteTools).
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { tool as aiTool } from 'ai';
import { ToolDescriptor } from '../../types';
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
 * List the tools a connected MCP client's server advertises.
 *
 * This is a thin wrapper around `client.listTools()` - it returns
 * `response.tools` as-is and deliberately does NOT catch/wrap connection
 * errors: a `listTools()` rejection (e.g. the client isn't connected, or
 * the transport drops) propagates straight out to the caller.
 */
export async function listRemoteTools(client: Client): Promise<RawMcpTool[]> {
  const response = await client.listTools();
  return response.tools as unknown as RawMcpTool[];
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
 */
export async function loadMcpTools(
  client: Client,
  connectionName: string
): Promise<Record<string, ToolDescriptor>> {
  const rawTools = await listRemoteTools(client);
  const descriptors: Record<string, ToolDescriptor> = {};

  for (const rawTool of rawTools) {
    const key = `${connectionName}__${rawTool.name}`;
    const parameters = jsonSchemaToZod(rawTool.inputSchema);

    descriptors[key] = {
      displayName: rawTool.description || rawTool.name,
      tool: aiTool({
        description: rawTool.description || '',
        parameters: parameters as any,
        execute: async (args: Record<string, unknown>) => {
          return client.callTool({ name: rawTool.name, arguments: args });
        },
      }),
    };
  }

  return descriptors;
}
