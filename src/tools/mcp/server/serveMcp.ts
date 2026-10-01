/**
 * `serveMcp()` - expose a Loushy agent (and optionally some of its tools) as
 * a Model Context Protocol server, so Claude Code, Cursor and other MCP
 * clients can call it (LOU-Z3).
 */
import type { SimpleAgent } from '../../../createAgent';
import { loadOptionalPeer } from '../../../providers/optionalPeer';
import type { DefinedTool } from '../../defineTool';
import { needsApprovalGate, sanitizeToolName } from './toolNames';
import { buildServer, type ServerSpec } from './buildServer';
import { listenHttp, type McpHttpTransportOptions } from './httpTransport';
import { ConfigurationError } from '../../../execution/errors';

export type { McpHttpTransportOptions } from './httpTransport';

/** Options for {@link serveMcp}. */
export interface ServeMcpOptions {
  /** The agent from `createAgent()`. It is exposed as ONE tool taking `{ message: string }`. */
  agent: SimpleAgent;
  /** MCP server name, shown by clients. Also the base of the default tool name. */
  name: string;
  /** Description of the agent tool; tells the calling model when to use it. */
  description?: string;
  /** Server version reported to clients. Defaults to `'1.0.0'`. */
  version?: string;
  /** Name of the agent tool. Defaults to `name` with characters outside `[A-Za-z0-9_-]` replaced by `_`. */
  toolName?: string;
  /** Tools (from `defineTool()`) to also expose directly, next to the agent tool. */
  tools?: readonly DefinedTool[];
  /**
   * Expose tools flagged `needsApproval` too. Off by default. MCP has no
   * approval step here, so enabling this lets clients run those tools with
   * NO human gate.
   */
  allowApprovalTools?: boolean;
  /** `'stdio'` (default) or `{ type: 'http', port, host, path, auth }`. */
  transport?: 'stdio' | McpHttpTransportOptions;
  /** Receives one-time warnings. Defaults to stderr (stdout is reserved for the stdio protocol). */
  warn?: (message: string) => void;
}

/** A running MCP server returned by {@link serveMcp}. */
export interface ServeMcpHandle {
  /** Name of the tool that runs the agent. */
  readonly agentToolName: string;
  /** Endpoint URL (HTTP transport only). */
  readonly url?: string;
  /** Bound port (HTTP transport only). */
  readonly port?: number;
  /** Stops serving and releases the transport. */
  close(): Promise<void>;
}

/** A `z.object()` of zod 3 (`_def.typeName`) or zod 4 (`_zod.def.type`). */
function isObjectSchema(schema: unknown): boolean {
  const internals = schema as { _def?: { typeName?: string }; _zod?: { def?: { type?: string } } } | undefined;
  return internals?._def?.typeName === 'ZodObject' || internals?._zod?.def?.type === 'object';
}

function assertTools(tools: readonly DefinedTool[], agentToolName: string): void {
  const seen = new Set([agentToolName]);
  for (const tool of tools) {
    if (!isObjectSchema(tool.input)) {
      throw new ConfigurationError(`serveMcp: tool '${tool.name}' needs a z.object(...) input; MCP tool inputs must be objects.`, 'tools');
    }
    if (seen.has(tool.name)) {
      throw new ConfigurationError(
        `serveMcp: two tools are named '${tool.name}'. Rename the tool, or set \`toolName\` to rename the agent tool.`,
        'tools'
      );
    }
    seen.add(tool.name);
  }
}

function assertOptions(options: ServeMcpOptions, agentToolName: string): void {
  if (!options.agent || typeof options.agent.send !== 'function') {
    throw new ConfigurationError('serveMcp: `agent` must be the result of createAgent() (an object with a send() method).', 'agent');
  }
  if (!options.name) {
    throw new ConfigurationError("serveMcp: `name` is required (e.g. serveMcp({ agent, name: 'support-bot' })).", 'name');
  }
  assertTools(options.tools ?? [], agentToolName);
}

function stderrWarn(message: string): void {
  console.error(message);
}

interface Running {
  url?: string;
  port?: number;
  close(): Promise<void>;
}

async function listen(
  transport: ServeMcpOptions['transport'],
  spec: ServerSpec,
  warn: (message: string) => void
): Promise<Running> {
  const create = () => buildServer(spec);
  if (transport !== undefined && transport !== 'stdio') {
    const http = await listenHttp(transport, create, warn);
    const host = http.host.includes(':') ? `[${http.host}]` : http.host;
    return { port: http.port, url: `http://${host}:${http.port}${http.path}`, close: http.close };
  }
  const { StdioServerTransport } = await loadOptionalPeer('@modelcontextprotocol/sdk', () =>
    import('@modelcontextprotocol/sdk/server/stdio.js')
  );
  const server = await create();
  await server.connect(new StdioServerTransport());
  return { close: () => server.close() };
}

/**
 * Serves an agent over MCP. Each MCP call is a fresh, stateless conversation.
 * Tools flagged `needsApproval` are not exposed unless `allowApprovalTools`
 * is set, and an agent run that pauses for approval is returned as an error
 * (approvals cannot be given over MCP).
 *
 * @example
 * ```ts
 * const server = await serveMcp({ agent, name: 'support-bot', description: 'Ask the support agent a question' });
 * await server.close();
 * ```
 */
export async function serveMcp(options: ServeMcpOptions): Promise<ServeMcpHandle> {
  const agentToolName = sanitizeToolName(options.toolName ?? options.name);
  assertOptions(options, agentToolName);

  const tools = options.tools ?? [];
  const spec = {
    agent: options.agent,
    name: options.name,
    version: options.version ?? '1.0.0',
    description: options.description,
    agentToolName,
    tools,
    allowApprovalTools: options.allowApprovalTools === true,
  };
  const warn = options.warn ?? stderrWarn;
  if (spec.allowApprovalTools && tools.some(needsApprovalGate)) {
    warn('serveMcp: allowApprovalTools is on - tools flagged needsApproval will run WITHOUT a human gate.');
  }
  const running = await listen(options.transport, spec, warn);
  return { agentToolName, url: running.url, port: running.port, close: running.close };
}
