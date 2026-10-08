/**
 * `createAgent({ mcpServers })` wiring (LOU-Z4): connects the servers with
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
import { connectMcp, type McpConnections } from './connect';
import { assertMcpOAuth, completeMcpSignIn, hasMcpOAuth, mcpStoreMissing, startMcpSignIn, type McpOAuthServerSpec } from './mcpOAuth';

/** An agent's MCP servers: connected by `ready()` (again after a `close()`), disconnected by `close()`. */
export interface AgentMcp {
  ready(): Promise<void>;
  close(): Promise<void>;
  /** N9c: the operator's sign-in to servers with `oauth` (`agent.oauth.mcpSignInUrl()` and the callback). */
  oauth?: McpOAuthSignIn;
}

/**
 * N9c: sign-ins to the servers with `oauth`. Nothing to reset after one: the
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

/**
 * Connects `servers` on the first `ready()` (a failure is not cached, so the
 * next call retries) and hands their tools to `register`. Without servers,
 * both methods are no-ops. Servers with `oauth` keep their tokens in `tokens`.
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
  const connect = lazyValue(async (): Promise<McpConnections> => {
    const connections = await connectMcp(servers, { ...(tokens && { tokens }) });
    register(connections.tools);
    return connections;
  });
  let latest: Promise<McpConnections> | undefined;
  let closed = false;
  // After close(), the next ready() reconnects the servers (their tools stay registered).
  const ready = async () => {
    const connections = await (latest = connect());
    if (!closed) return;
    closed = false;
    await connections.reconnect();
  };
  // Closes what the latest ready() opened; never starts a connection.
  const close = async () => {
    const connections = await latest?.catch(() => undefined);
    if (!connections) return;
    closed = true;
    await connections.close();
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
 * `AgentExecutor.stream()` of the options `prepare()` resolves to (LOU-V15); a rejection fails the run.
 * `around` (Eve DUR-F2) wraps the preparation and the whole run, e.g. to queue it behind other runs.
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
