/**
 * MCP Tool Loader (LOU-F2 / LOU-F3)
 *
 * Loads tools advertised by a remote MCP server (via an already-connected
 * `Client` from `@modelcontextprotocol/sdk`) and turns them into raw MCP
 * tool descriptions (listRemoteTools).
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

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
