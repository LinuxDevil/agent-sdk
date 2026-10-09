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
import type { McpServerSpec, McpStdioServerSpec } from '../../spec/schema';
import type { NamedToolDescriptor } from '../../types';
import type { OAuthTokenStore } from '../../oauth/types';
import { noopLogger, type Logger } from '../../execution/logger';
import { SDKError } from '../../utils/sdkError';
import { loadOptionalPeer, MissingPeerDependencyError } from '../../providers/optionalPeer';
import { loadMcpTools, type McpClientLike } from './McpToolLoader';
import { assertMcpOAuth, hasMcpOAuth, isMcpAuthError, mcpAuthRequired, mcpFetch, mcpStoreMissing, storeOAuthProvider } from './mcpOAuth';

/**
 * Where one server's connection stands: not open (yet, or after `close()`),
 * open, failed (it could not connect, or its connection dropped without a
 * `close()`, e.g. the stdio process exited; Eve TOOLS-F18), or (N9c) waiting
 * for an operator's OAuth sign-in.
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
  /**
   * Eve TOOLS-F18: called after a server sent `notifications/tools/list_changed`
   * and its tools were listed again; `tools` is the updated
   * {@link McpConnections.tools} record (updated in place).
   */
  onToolsChanged?: (tools: Record<string, NamedToolDescriptor>) => void;
}

/** The connected servers returned by {@link connectMcp}. */
export interface McpConnections {
  /**
   * Every server's tools, keyed `<server>__<tool>` (also the `name` each
   * descriptor carries); pass them to `createAgent({ tools })` as the record
   * they are, inside a `tools` array, or as `Object.values(tools)` (LOU-R12).
   * A server's `notifications/tools/list_changed` lists its tools again and
   * updates this record in place (Eve TOOLS-F18).
   */
  readonly tools: Record<string, NamedToolDescriptor>;
  /** Disconnects every server (stops stdio processes). */
  close(): Promise<void>;
  /**
   * Reconnects every loaded server that is not connected (after `close()` or a
   * dropped connection), also with `lazy: false`; resolves once they are.
   */
  reconnect(): Promise<void>;
  /** Each server's {@link McpServerStatus}, keyed by name. */
  status(): Record<string, McpServerStatus>;
}

const PEER = '@modelcontextprotocol/sdk';

/** How many trailing stderr lines a start failure keeps. */
const STDERR_TAIL_LINES = 20;

/**
 * A stdio MCP server failed to start (`LOUSHO_MCP_START_FAILED`): the command
 * is missing, the process exited, or it did not answer `initialize` in time.
 * Carries the exit code and the last lines the process wrote to stderr.
 */
export class McpStartError extends SDKError {
  /** The process's exit code, when it exited. */
  readonly exitCode?: number;
  /** The signal that ended the process, when one did. */
  readonly signal?: string;
  /** The last lines the process wrote to stderr (empty with `stderr: 'inherit'` or `'ignore'`). */
  readonly stderr: string;

  constructor(server: string, reason: string, details: { exitCode?: number; signal?: string; stderr: string; cause?: unknown }) {
    const exit = details.exitCode !== undefined ? `exit code ${details.exitCode}` : details.signal && `signal ${details.signal}`;
    const stderr = details.stderr.trim();
    super(
      `MCP server '${server}' failed to start: ${reason}${exit ? ` (${exit})` : ''}.${stderr ? `\nLast stderr lines:\n${stderr}` : ''}`,
      'LOUSHO_MCP_START_FAILED',
      { cause: details.cause }
    );
    this.name = 'McpStartError';
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
    if (details.signal) this.signal = details.signal;
    this.stderr = details.stderr;
  }
}

/** What a stdio server's process did while starting: its stderr tail and how it exited. */
interface StdioWatch {
  stderr(): string;
  exit(): { exitCode?: number; signal?: string };
}

/** The part of a spawned process the watch reads. */
interface ExitEmitter {
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
}

/**
 * Keeps the last {@link STDERR_TAIL_LINES} stderr lines of a stdio server
 * (copying them to this process's stderr with `'forward'`, the default) and
 * its exit code. The process is the transport's own (`_process`, set by
 * `start()`); without it only stderr is kept.
 */
function watchStdio(transport: Transport, mode: McpStdioServerSpec['stderr']): StdioWatch {
  let lines: string[] = [];
  let partial = '';
  const stream = (transport as { stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null }).stderr;
  if (stream && (mode === undefined || mode === 'forward' || mode === 'capture')) {
    stream.on('data', (chunk) => {
      const text = String(chunk);
      if (mode !== 'capture') process.stderr.write(text);
      const split = (partial + text).split(/\r?\n/);
      partial = split.pop() ?? '';
      lines = [...lines, ...split].slice(-STDERR_TAIL_LINES);
    });
  }
  let exited: { exitCode?: number; signal?: string } = {};
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    (transport as { _process?: ExitEmitter })._process?.once('exit', (code, signal) => {
      exited = { ...(code !== null && { exitCode: code }), ...(signal !== null && { signal }) };
    });
  };
  return {
    stderr: () => [...lines, ...(partial ? [partial] : [])].slice(-STDERR_TAIL_LINES).join('\n'),
    exit: () => exited,
  };
}

/** The `stderr` option of the MCP SDK's stdio transport for a spec's `stderr`. */
function stdioStderr(mode: McpStdioServerSpec['stderr']): 'pipe' | 'inherit' | 'ignore' {
  return mode === 'inherit' || mode === 'ignore' ? mode : 'pipe';
}

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
  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env,
    stderr: stdioStderr(server.stderr),
    ...(server.cwd !== undefined && { cwd: server.cwd }),
  });
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
  /** Eve TOOLS-F18: called when the server says its tool list changed. */
  onToolsChanged: (() => void) | undefined;

  constructor(
    readonly name: string,
    private readonly server: McpServerSpec,
    private readonly lazy: boolean,
    private readonly logger: Logger,
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
    let watch: StdioWatch | undefined;
    try {
      const { Client } = await loadOptionalPeer(PEER, () => import('@modelcontextprotocol/sdk/client/index.js'));
      const client = new Client({ name: `lousho-${this.name}`, version: '1.0.0' });
      const transport = await openTransport(this.server, this.authProvider);
      if ('command' in this.server) watch = watchStdio(transport, this.server.stderr);
      const timeout = this.server.connectTimeoutMs;
      try {
        await client.connect(transport, timeout === undefined ? undefined : { timeout });
      } catch (error) {
        // Stop the process (or session) a failed or timed-out start left behind.
        await client.close().catch(() => undefined);
        throw error;
      }
      const current = this.client;
      // A dropped connection (e.g. the process exited) counts as closed, and as failed (Eve TOOLS-F18).
      client.onclose = () => {
        if (this.client !== current) return;
        this.client = undefined;
        this.closed = true;
        this.status = 'failed';
        this.warnClosed(watch);
      };
      const { ToolListChangedNotificationSchema } = await loadOptionalPeer(PEER, () => import('@modelcontextprotocol/sdk/types.js'));
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.onToolsChanged?.();
      });
      this.status = 'connected';
      return client;
    } catch (error) {
      this.client = undefined;
      if (this.authProvider && (await isMcpAuthError(error))) {
        this.status = 'needs-auth';
        throw mcpAuthRequired(this.name);
      }
      this.status = 'failed';
      if (!watch || error instanceof MissingPeerDependencyError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new McpStartError(this.name, reason, { ...watch.exit(), stderr: watch.stderr(), cause: error });
    }
  }

  /** Eve TOOLS-F18: a connection that dropped without `close()` is logged, with the exit code and stderr tail. */
  private warnClosed(watch: StdioWatch | undefined): void {
    const { exitCode, signal } = watch?.exit() ?? {};
    const exit = exitCode !== undefined ? ` (exit code ${exitCode})` : signal ? ` (signal ${signal})` : '';
    const stderr = watch?.stderr().trim();
    this.logger.warn(
      `MCP server '${this.name}': the connection closed unexpectedly${exit}` +
        `${this.lazy ? '; the next tool call reconnects' : ''}.${stderr ? `\nLast stderr lines:\n${stderr}` : ''}`,
      { server: this.name, ...(exitCode !== undefined && { exitCode }), ...(signal && { signal }) }
    );
  }

  /** Opens the connection again after `close()`, whatever `lazy` says. */
  async reopen(): Promise<void> {
    this.closed = false;
    await this.use();
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
  const connections = Object.entries(servers).map(
    ([name, server]) => new ServerConnection(name, server, lazy, logger, oauthProvider(name, server, options.tokens))
  );
  const close = async () => {
    await Promise.all(connections.map((connection) => connection.close()));
  };
  const load = (connection: ServerConnection) =>
    loadMcpTools(connection.handle, connection.name, {
      logger,
      approval: servers[connection.name].approval,
      timeoutMs: servers[connection.name].timeoutMs,
      tools: servers[connection.name].tools,
      // N2: a server with `deferLoading` has all its tools withheld until `tool_search` finds them.
      ...(servers[connection.name].deferLoading && { deferLoading: true }),
    });
  const loaded = await Promise.allSettled(connections.map(load));

  const tools: Record<string, NamedToolDescriptor> = {};
  /** The keys of `tools` each server owns, so a re-list replaces only its own. */
  const owned = new Map<ServerConnection, string[]>();
  const add = (connection: ServerConnection, serverTools: Record<string, NamedToolDescriptor>) => {
    const keys: string[] = [];
    for (const [key, tool] of Object.entries(serverTools)) {
      // Two server names can sanitize to the same prefix (`a.b` and `a_b`); the first server keeps the name.
      if (Object.hasOwn(tools, key)) {
        logger.warn(`connectMcp: MCP server '${connection.name}': skipping tool '${key}', the name is taken by another server`, {
          server: connection.name,
          tool: key,
        });
        continue;
      }
      tools[key] = tool;
      keys.push(key);
    }
    owned.set(connection, keys);
  };
  /** Eve TOOLS-F18: after `notifications/tools/list_changed`, list the server's tools again. */
  const relist = async (connection: ServerConnection) => {
    try {
      const fresh = await load(connection);
      for (const key of owned.get(connection) ?? []) delete tools[key];
      add(connection, fresh);
      options.onToolsChanged?.(tools);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`connectMcp: MCP server '${connection.name}': could not list its changed tools: ${reason}`, {
        server: connection.name,
        reason,
      });
    }
  };
  const loadedConnections: ServerConnection[] = [];
  for (const [index, result] of loaded.entries()) {
    if (result.status === 'fulfilled') {
      const connection = connections[index];
      loadedConnections.push(connection);
      add(connection, result.value);
      connection.onToolsChanged = () => void relist(connection);
      continue;
    }
    const { name } = connections[index];
    const error: unknown = result.reason;
    const reason = error instanceof Error ? error.message : String(error);
    if (onError === 'throw' || error instanceof MissingPeerDependencyError) {
      await close();
      // N9c: LOUSHO_MCP_AUTH_REQUIRED (and LOUSHO_MCP_START_FAILED) keep their code.
      throw error instanceof MissingPeerDependencyError || error instanceof McpStartError || connections[index].status === 'needs-auth'
        ? error
        : new Error(`connectMcp: MCP server '${name}' failed to connect: ${reason}`, { cause: error });
    }
    logger.warn(`connectMcp: skipping MCP server '${name}': ${reason}`, { server: name, reason });
  }

  return {
    tools,
    close,
    reconnect: async () => {
      await Promise.all(loadedConnections.map((connection) => connection.reopen()));
    },
    status: () => Object.fromEntries(connections.map((connection) => [connection.name, connection.status])),
  };
}
