/**
 * connectMcp() - connect MCP servers from config (LOU-Z4).
 *
 * Opens one `@modelcontextprotocol/sdk` client per `McpServerSpec` (stdio:
 * spawn `command`; HTTP: streamable HTTP to `url`), lists each server's
 * tools and returns them as `ToolDescriptor`s named `<server>__<tool>`.
 * The MCP SDK is an optional peer, loaded on first use.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { McpServerSpec } from '../../spec/schema';
import type { NamedToolDescriptor } from '../../types';
import type { OAuthTokenStore } from '../../oauth/types';
import { noopLogger, type Logger } from '../../execution/logger';
import { loadOptionalPeer, MissingPeerDependencyError } from '../../providers/optionalPeer';
import { loadMcpTools, type McpClientLike } from './McpToolLoader';
import { assertMcpOAuth, hasMcpOAuth, isMcpAuthError, mcpAuthRequired, mcpFetch, mcpStoreMissing, storeOAuthProvider } from './mcpOAuth';

/**
 * Where one server's connection stands: not open (yet, or after `close()`),
 * open, failed, or (N9c) waiting for an operator's OAuth sign-in.
 */
export type McpServerStatus = 'idle' | 'connected' | 'failed' | 'needs-auth';

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
  /**
   * N9c: where servers with `oauth` keep their tokens (`AgentStore.tokens`);
   * required when any server has `oauth` (`LOUSHO_OAUTH_STORE_MISSING`).
   */
  tokens?: OAuthTokenStore;
}

/** The connected servers returned by {@link connectMcp}. */
export interface McpConnections {
  /**
   * Every server's tools, keyed `<server>__<tool>` (also the `name` each
   * descriptor carries); pass them to `createAgent({ tools })` as the record
   * they are, inside a `tools` array, or as `Object.values(tools)` (LOU-R12).
   */
  readonly tools: Record<string, NamedToolDescriptor>;
  /** Disconnects every server (stops stdio processes). */
  close(): Promise<void>;
  /** Each server's {@link McpServerStatus}, keyed by name. */
  status(): Record<string, McpServerStatus>;
}

const PEER = '@modelcontextprotocol/sdk';

async function openTransport(server: McpServerSpec, authProvider?: OAuthClientProvider): Promise<Transport> {
  if ('url' in server) {
    const { StreamableHTTPClientTransport } = await loadOptionalPeer(
      PEER,
      () => import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    );
    // N9c: with OAuth, `headers` go only to the server's own origin (mcpFetch), never to its authorization server.
    const options = authProvider ? { authProvider, fetch: mcpFetch(server) } : { requestInit: { headers: server.headers } };
    return new StreamableHTTPClientTransport(new URL(server.url), options);
  }
  const { StdioClientTransport, getDefaultEnvironment } = await loadOptionalPeer(
    PEER,
    () => import('@modelcontextprotocol/sdk/client/stdio.js')
  );
  // A given `env` replaces the child's whole environment in the SDK; keep PATH and friends.
  const env = server.env && { ...getDefaultEnvironment(), ...server.env };
  return new StdioClientTransport({ command: server.command, args: server.args, env });
}

/** N9c: the OAuth provider of a server with `oauth` (validated, and refused without a token store). */
function oauthProvider(name: string, server: McpServerSpec, tokens: OAuthTokenStore | undefined): OAuthClientProvider | undefined {
  if (!hasMcpOAuth(server)) return undefined;
  assertMcpOAuth(name, server);
  if (!tokens) throw mcpStoreMissing(name);
  return storeOAuthProvider(name, server, tokens);
}

/** One server: connects on demand and remembers its status. */
class ServerConnection {
  status: McpServerStatus = 'idle';
  private client: Promise<Client> | undefined;
  private closed = false;

  constructor(
    readonly name: string,
    private readonly server: McpServerSpec,
    private readonly lazy: boolean,
    private readonly authProvider?: OAuthClientProvider
  ) {}

  /** What the tool descriptors call through: the current client, reconnected if needed. */
  readonly handle: McpClientLike = {
    listTools: (params, options) =>
      this.use().then((client) => client.listTools(params, options as RequestOptions).catch((error: unknown) => this.failed(error))),
    callTool: (params, resultSchema, options) =>
      this.use().then((client) =>
        client.callTool(params, resultSchema as never, options as RequestOptions).catch((error: unknown) => this.failed(error))
      ),
  };

  /**
   * N9c: a call refused for want of a sign-in (a revoked grant) drops the
   * client, so the next call reconnects with the token the operator stores.
   */
  private async failed(error: unknown): Promise<never> {
    if (!this.authProvider || !(await isMcpAuthError(error))) throw error;
    const client = this.client;
    this.client = undefined;
    this.status = 'needs-auth';
    void client?.then((open) => open.close()).catch(() => undefined);
    throw mcpAuthRequired(this.name);
  }

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
      const client = new Client({ name: `lousho-${this.name}`, version: '1.0.0' });
      await client.connect(await openTransport(this.server, this.authProvider));
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
      if (this.authProvider && (await isMcpAuthError(error))) {
        this.status = 'needs-auth';
        throw mcpAuthRequired(this.name);
      }
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
  const connections = Object.entries(servers).map(([name, server]) => new ServerConnection(name, server, lazy, oauthProvider(name, server, options.tokens)));
  const close = async () => {
    await Promise.all(connections.map((connection) => connection.close()));
  };
  const loaded = await Promise.allSettled(
    connections.map((connection) =>
      loadMcpTools(connection.handle, connection.name, {
        logger,
        approval: servers[connection.name].approval,
        timeoutMs: servers[connection.name].timeoutMs,
        tools: servers[connection.name].tools,
        // N2: a server with `deferLoading` has all its tools withheld until `tool_search` finds them.
        ...(servers[connection.name].deferLoading && { deferLoading: true }),
      })
    )
  );

  const tools: Record<string, NamedToolDescriptor> = {};
  for (const [index, result] of loaded.entries()) {
    if (result.status === 'fulfilled') {
      for (const [key, tool] of Object.entries(result.value)) {
        // Two server names can sanitize to the same prefix (`a.b` and `a_b`); the first server keeps the name.
        if (Object.hasOwn(tools, key)) {
          logger.warn(`connectMcp: MCP server '${connections[index].name}': skipping tool '${key}', the name is taken by another server`, {
            server: connections[index].name,
            tool: key,
          });
          continue;
        }
        tools[key] = tool;
      }
      continue;
    }
    const { name } = connections[index];
    const error: unknown = result.reason;
    const reason = error instanceof Error ? error.message : String(error);
    if (onError === 'throw' || error instanceof MissingPeerDependencyError) {
      await close();
      // N9c: LOUSHO_MCP_AUTH_REQUIRED keeps its code.
      throw error instanceof MissingPeerDependencyError || connections[index].status === 'needs-auth'
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
