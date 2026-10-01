/**
 * connectMcp() - connect MCP servers from config (LOU-Z4).
 *
 * Opens one `@modelcontextprotocol/sdk` client per `McpServerSpec` (stdio:
 * spawn `command`; HTTP: streamable HTTP to `url`), lists each server's
 * tools and returns them as `ToolDescriptor`s named `<server>__<tool>`.
 * The MCP SDK is an optional peer, loaded on first use.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerSpec } from '../../spec/schema';
import type { ToolDescriptor } from '../../types';
import { noopLogger, type Logger } from '../../execution/logger';
import { loadOptionalPeer, MissingPeerDependencyError } from '../../providers/optionalPeer';
import { loadMcpTools, type McpClientLike } from './McpToolLoader';

/** Where one server's connection stands: not open (yet, or after `close()`), open, or failed. */
export type McpServerStatus = 'idle' | 'connected' | 'failed';

/** Options for {@link connectMcp}. */
export interface ConnectMcpOptions {
  /**
   * Listing tools needs a connection, so every server is connected when
   * `connectMcp()` resolves. `lazy` decides what a tool call does after
   * `close()` or a dropped connection: `true` (default) reconnects on
   * demand, `false` fails the call.
   */
  lazy?: boolean;
  /** A server that cannot connect: `'throw'` (default) rejects; `'skip'` warns through `logger` and leaves it out. */
  onError?: 'throw' | 'skip';
  /** Receives skipped-server and skipped-tool warnings. Defaults to a no-op logger. */
  logger?: Logger;
}

/** The connected servers returned by {@link connectMcp}. */
export interface McpConnections {
  /** Every server's tools, keyed `<server>__<tool>`; pass them to `createAgent({ tools })`. */
  readonly tools: Record<string, ToolDescriptor>;
  /** Disconnects every server (stops stdio processes). */
  close(): Promise<void>;
  /** Each server's {@link McpServerStatus}, keyed by name. */
  status(): Record<string, McpServerStatus>;
}

const PEER = '@modelcontextprotocol/sdk';

async function openTransport(server: McpServerSpec): Promise<Transport> {
  if ('url' in server) {
    const { StreamableHTTPClientTransport } = await loadOptionalPeer(
      PEER,
      () => import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    );
    return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
  }
  const { StdioClientTransport, getDefaultEnvironment } = await loadOptionalPeer(
    PEER,
    () => import('@modelcontextprotocol/sdk/client/stdio.js')
  );
  // A given `env` replaces the child's whole environment in the SDK; keep PATH and friends.
  const env = server.env && { ...getDefaultEnvironment(), ...server.env };
  return new StdioClientTransport({ command: server.command, args: server.args, env });
}

/** One server: connects on demand and remembers its status. */
class ServerConnection {
  status: McpServerStatus = 'idle';
  private client: Promise<Client> | undefined;
  private closed = false;

  constructor(
    readonly name: string,
    private readonly server: McpServerSpec,
    private readonly lazy: boolean
  ) {}

  /** What the tool descriptors call through: the current client, reconnected if needed. */
  readonly handle: McpClientLike = {
    listTools: (params) => this.use().then((client) => client.listTools(params)),
    callTool: (params) => this.use().then((client) => client.callTool(params)),
  };

  private use(): Promise<Client> {
    if (this.closed && !this.lazy) {
      return Promise.reject(new Error(`MCP server '${this.name}' is closed (connectMcp({ lazy: false })).`));
    }
    this.client ??= this.open();
    return this.client;
  }

  private async open(): Promise<Client> {
    try {
      const { Client } = await loadOptionalPeer(PEER, () => import('@modelcontextprotocol/sdk/client/index.js'));
      const client = new Client({ name: `loushy-${this.name}`, version: '1.0.0' });
      await client.connect(await openTransport(this.server));
      const current = this.client;
      // A dropped connection (e.g. the process exited) counts as closed.
      client.onclose = () => {
        if (this.client !== current) return;
        this.client = undefined;
        this.closed = true;
        this.status = 'idle';
      };
      this.status = 'connected';
      return client;
    } catch (error) {
      this.client = undefined;
      this.status = 'failed';
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.closed = true;
    await (await client?.catch(() => undefined))?.close();
    if (this.status === 'connected') this.status = 'idle';
  }
}

/**
 * Connects MCP servers from config and loads their tools, keyed
 * `<server>__<tool>` so two servers' tools never collide.
 *
 * @example
 * ```ts
 * const mcp = await connectMcp({ docs: { url: 'https://example.com/mcp' } }, { onError: 'skip', logger: console });
 * const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: mcp.tools });
 * await mcp.close(); // when done
 * ```
 */
export async function connectMcp(
  servers: Record<string, McpServerSpec>,
  options: ConnectMcpOptions = {}
): Promise<McpConnections> {
  const { lazy = true, onError = 'throw', logger = noopLogger } = options;
  const connections = Object.entries(servers).map(([name, server]) => new ServerConnection(name, server, lazy));
  const close = async () => {
    await Promise.all(connections.map((connection) => connection.close()));
  };
  const loaded = await Promise.allSettled(
    connections.map((connection) =>
      loadMcpTools(connection.handle, connection.name, { logger, approval: servers[connection.name].approval })
    )
  );

  const tools: Record<string, ToolDescriptor> = {};
  for (const [index, result] of loaded.entries()) {
    if (result.status === 'fulfilled') {
      Object.assign(tools, result.value);
      continue;
    }
    const { name } = connections[index];
    const error: unknown = result.reason;
    const reason = error instanceof Error ? error.message : String(error);
    if (onError === 'throw' || error instanceof MissingPeerDependencyError) {
      await close();
      throw error instanceof MissingPeerDependencyError
        ? error
        : new Error(`connectMcp: MCP server '${name}' failed to connect: ${reason}`, { cause: error });
    }
    logger.warn(`connectMcp: skipping MCP server '${name}': ${reason}`, { server: name, reason });
  }

  return {
    tools,
    close,
    status: () => Object.fromEntries(connections.map((connection) => [connection.name, connection.status])),
  };
}
