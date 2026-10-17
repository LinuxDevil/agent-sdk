/**
 * `createAgent({ mcpServers })` wiring: connects the servers with
 * `connectMcp()` on first use and registers their tools on the agent.
 */
import type { McpServerSpec } from '../../spec/schema';
import type { ToolDescriptor } from '../../types';
import type { OAuthTokenStore } from '../../oauth/types';
import type { McpOAuthSignIn } from '../../oauth/agentOAuth';
import { ConfigurationError } from '../../execution/errors';
import { AgentExecutor, type ExecuteOptions, type ExecutionResult } from '../../execution/AgentExecutor';
import { RUN_EVENTS, startAgentRun, type AgentRun, type StreamingExecuteOptions } from '../../execution/agentRun';
import { lazyValue } from '../../providers/optionalPeer';
import { noopLogger, type Logger } from '../../execution/logger';
import { connectMcp, type McpConnections } from './connect';
import { assertMcpOAuth, completeMcpSignIn, hasMcpOAuth, mcpStoreMissing, startMcpSignIn, type McpOAuthServerSpec } from './mcpOAuth';

/** An agent's MCP servers: connected by `ready()` (again after a `close()`), disconnected by `close()`. */
export interface AgentMcp {
  ready(): Promise<void>;
  close(): Promise<void>;
  /** The operator's sign-in to servers with `oauth` (`agent.oauth.mcpSignInUrl()` and the callback). */
  oauth?: McpOAuthSignIn;
}

/**
 * Sign-ins to the servers with `oauth`. Nothing to reset after one: the
 * transport reads the token from the store on every request, and a server
 * that needed a sign-in has no open client, so the next `ready()` or tool
 * call connects with the new token.
 */
function mcpOAuthSignIn(servers: Record<string, McpServerSpec>, tokens: OAuthTokenStore | undefined): McpOAuthSignIn | undefined {
  const oauthServers = Object.entries(servers).filter((entry): entry is [string, McpOAuthServerSpec] => hasMcpOAuth(entry[1]));
  if (oauthServers.length === 0) return undefined;
  for (const [name, server] of oauthServers) assertMcpOAuth(name, server);
  const specOf = (name: string): [McpOAuthServerSpec, OAuthTokenStore] => {
    const server = servers[name];
    if (!Object.hasOwn(servers, name) || !hasMcpOAuth(server)) {
      throw new ConfigurationError(`agent.oauth.mcpSignInUrl('${name}'): no HTTP MCP server named '${name}' has \`oauth\`.`, 'server');
    }
    if (!tokens) throw mcpStoreMissing(name);
    return [server, tokens];
  };
  return {
    signInUrl: async (name) => startMcpSignIn(name, ...specOf(name)),
    complete: async (name, pending, code) => completeMcpSignIn(name, ...specOf(name), pending, code),
  };
}

/** Reports a skipped `optional` server; connectMcp's other warnings (a skipped tool name) stay quiet, as before. */
const optionalServerLogger: Logger = {
  ...noopLogger,
  warn(message, meta) {
    if (message.startsWith('connectMcp: skipping MCP server')) console.warn(`[lousho] ${message} (optional: true)`, meta ?? '');
  },
};

/**
 * Connects `servers` on the first `ready()` (a failure is not cached, so the
 * next call retries) and hands their tools to `register`. Without servers,
 * both methods are no-ops. Servers with `oauth` keep their tokens in `tokens`.
 *
 * Servers with `optional: true` connect in the BACKGROUND: `ready()` - and so
 * `send()`/`stream()` - does not wait for them, and their tools join the agent
 * (through `register`, like a `tools/list_changed` update) whenever the
 * connection lands. `optional` already means "the agent works without this
 * server", so a slow or hanging optional server must not hold up the first
 * run; a run started before it connects simply has no optional tools.
 */
export function agentMcp(
  servers: Record<string, McpServerSpec> | undefined,
  register: (tools: Record<string, ToolDescriptor>) => void,
  tokens?: OAuthTokenStore
): AgentMcp {
  if (!servers || Object.keys(servers).length === 0) {
    return { ready: () => Promise.resolve(), close: () => Promise.resolve() };
  }
  const oauth = mcpOAuthSignIn(servers, tokens);
  const entries = Object.entries(servers);
  const required = Object.fromEntries(entries.filter(([, server]) => !server.optional));
  const optional = Object.fromEntries(entries.filter(([, server]) => server.optional));
  const hasOptional = Object.keys(optional).length > 0;
  const shared = {
    ...(tokens && { tokens }),
    onToolsChanged: (tools: Record<string, ToolDescriptor>) => register(tools),
    // A server with `optional: true` that fails to connect is skipped with this warning.
    logger: optionalServerLogger,
  };
  // A server's `tools/list_changed` hands the updated tools to `register` again.
  const connectRequired = lazyValue(async (): Promise<McpConnections> => {
    const connections = await connectMcp(required, shared);
    register(connections.tools);
    return connections;
  });
  const connectOptional = lazyValue(async (): Promise<McpConnections> => {
    const connections = await connectMcp(optional, shared);
    register(connections.tools);
    return connections;
  });
  let latest: Promise<McpConnections> | undefined;
  let optionalConnect: Promise<McpConnections> | undefined;
  let closedRequired = false;
  let closedOptional = false;
  /** Ready's optional-server half: never awaited, so a slow server cannot block a run. */
  const readyOptional = async (): Promise<void> => {
    try {
      const connections = await (optionalConnect ??= connectOptional());
      if (!closedOptional) return;
      closedOptional = false;
      await connections.reconnect();
    } catch {
      // connectMcp already skips a failing optional server; this catches the
      // rest (e.g. a missing peer) so a background connect never surfaces.
    }
  };
  // After close(), the next ready() reconnects the servers (their tools stay registered).
  const ready = async () => {
    if (hasOptional) void readyOptional();
    if (Object.keys(required).length === 0) return;
    const connections = await (latest = connectRequired());
    if (!closedRequired) return;
    closedRequired = false;
    await connections.reconnect();
  };
  // Closes what the latest ready() opened; never starts a connection.
  const close = async () => {
    const optionalConnections = await optionalConnect?.catch(() => undefined);
    const connections = await latest?.catch(() => undefined);
    if (!connections && !optionalConnections) return;
    closedRequired = true;
    closedOptional = true;
    await Promise.all([connections?.close(), optionalConnections?.close()]);
  };
  return { ready, close, ...(oauth && { oauth }) };
}

/** `AgentExecutor.stream(options)`, started once `ready()` resolves (a rejection fails the run). */
export function streamAfter(ready: () => Promise<void>, options: ExecuteOptions): AgentRun {
  return streamPrepared(
    async () => {
      await ready();
      return options;
    },
    options.signal,
    options.inputQueue
  );
}

/**
 * `AgentExecutor.stream()` of the options `prepare()` resolves to; a rejection fails the run.
 * `around` wraps the preparation and the whole run, e.g. to queue it behind other runs.
 */
export function streamPrepared(
  prepare: () => Promise<ExecuteOptions>,
  runSignal?: AbortSignal,
  runInputQueue?: ExecuteOptions['inputQueue'],
  around: (task: () => Promise<ExecutionResult>) => Promise<ExecutionResult> = (task) => task()
): AgentRun {
  return startAgentRun(
    ({ signal, sink, inputQueue }) =>
      around(async () => {
        const options = await prepare();
        const streaming: StreamingExecuteOptions = { ...options, signal, inputQueue, [RUN_EVENTS]: sink };
        return AgentExecutor.execute(streaming);
      }),
    runSignal,
    runInputQueue
  );
}
