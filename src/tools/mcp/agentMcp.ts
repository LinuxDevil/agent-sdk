/**
 * `createAgent({ mcpServers })` wiring (LOU-Z4): connects the servers with
 * `connectMcp()` on first use and registers their tools on the agent.
 */
import type { McpServerSpec } from '../../spec/schema';
import type { ToolDescriptor } from '../../types';
import { AgentExecutor, type ExecuteOptions } from '../../execution/AgentExecutor';
import { RUN_EVENTS, startAgentRun, type AgentRun, type StreamingExecuteOptions } from '../../execution/agentRun';
import { lazyValue } from '../../providers/optionalPeer';
import { connectMcp, type McpConnections } from './connect';

/** An agent's MCP servers: connected once by `ready()`, disconnected by `close()`. */
export interface AgentMcp {
  ready(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Connects `servers` on the first `ready()` (a failure is not cached, so the
 * next call retries) and hands their tools to `register`. Without servers,
 * both methods are no-ops.
 */
export function agentMcp(
  servers: Record<string, McpServerSpec> | undefined,
  register: (tools: Record<string, ToolDescriptor>) => void
): AgentMcp {
  if (!servers || Object.keys(servers).length === 0) {
    return { ready: () => Promise.resolve(), close: () => Promise.resolve() };
  }
  const connect = lazyValue(async (): Promise<McpConnections> => {
    const connections = await connectMcp(servers);
    register(connections.tools);
    return connections;
  });
  let latest: Promise<McpConnections> | undefined;
  const ready = async () => {
    await (latest = connect());
  };
  // Closes what the latest ready() opened; never starts a connection.
  const close = async () => {
    await (await latest?.catch(() => undefined))?.close();
  };
  return { ready, close };
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

/** `AgentExecutor.stream()` of the options `prepare()` resolves to (LOU-V15); a rejection fails the run. */
export function streamPrepared(
  prepare: () => Promise<ExecuteOptions>,
  runSignal?: AbortSignal,
  runInputQueue?: ExecuteOptions['inputQueue']
): AgentRun {
  return startAgentRun(async ({ signal, onEvent, sink, inputQueue }) => {
    const options = await prepare();
    const streaming: StreamingExecuteOptions = {
      ...options,
      signal,
      inputQueue,
      onEvent: (event) => {
        options.onEvent?.(event);
        onEvent(event);
      },
      [RUN_EVENTS]: sink,
    };
    return AgentExecutor.execute(streaming);
  }, runSignal, runInputQueue);
}
