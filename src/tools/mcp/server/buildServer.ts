/**
 * Builds the `McpServer` that fronts an agent (and optionally some of its
 * tools). Transport-agnostic: `serveMcp` connects the result to stdio or HTTP.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { SimpleAgent } from '../../../createAgent';
import type { ExecutionResult } from '../../../execution/AgentExecutor';
import type { DefinedTool } from '../../defineTool';
import { getToolExecute } from '../../toolContract';
import { loadOptionalPeer } from '../../../providers/optionalPeer';
import { needsApprovalGate, toolAnnotations } from './toolNames';

/** What {@link buildServer} needs, already validated by `serveMcp`. */
export interface ServerSpec {
  agent: SimpleAgent;
  name: string;
  version: string;
  description?: string;
  /** Name of the tool that runs the agent. */
  agentToolName: string;
  tools: readonly DefinedTool[];
  allowApprovalTools: boolean;
}

export { sanitizeToolName } from './toolNames';

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Maps a finished agent run to an MCP tool result. */
function agentResultToMcp(result: ExecutionResult): CallToolResult {
  if (result.finishReason === 'awaiting-approval') {
    return textResult(
      'The agent paused because one of its tools needs human approval. ' +
        'Approval-gated tools cannot be approved over MCP, so this call cannot finish. ' +
        'Remove needsApproval from the tool, or run the agent where approvals can be given.',
      true
    );
  }
  if (result.finishReason === 'aborted') return textResult('The agent run was cancelled.', true);
  if (result.finishReason === 'max-steps') return textResult('The agent ran out of steps (maxSteps) before finishing.', true);
  if (result.finishReason === 'error') {
    return textResult(`The agent failed: ${result.text || 'the model reported an error'}`, true);
  }
  return textResult(result.text);
}

function registerAgentTool(server: McpServer, spec: ServerSpec): void {
  server.registerTool(
    spec.agentToolName,
    {
      description: spec.description ?? `Send a message to the ${spec.name} agent and get its reply.`,
      inputSchema: { message: z.string().describe('The message to send to the agent.') },
    },
    async ({ message }, extra) => {
      try {
        // Each call is a fresh conversation; the MCP request signal cancels the run.
        return agentResultToMcp(await spec.agent.send(message, { signal: extra.signal }));
      } catch (error) {
        return textResult(`The agent failed: ${errorMessage(error)}`, true);
      }
    }
  );
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  return JSON.stringify(output ?? null) ?? 'null';
}

type ToolExecute = (
  args: unknown,
  options: { toolCallId: string; messages: never[]; abortSignal: AbortSignal }
) => unknown;

function registerDirectTool(server: McpServer, tool: DefinedTool): void {
  server.registerTool(
    tool.name,
    // serveMcp() checked it is a z.object() of either major; the MCP SDK takes both.
    { description: tool.description, inputSchema: tool.input as z.ZodTypeAny, annotations: toolAnnotations(tool) },
    async (args: unknown, extra) => {
      try {
        const execute = getToolExecute(tool) as ToolExecute | undefined;
        if (!execute) return textResult(`Tool '${tool.name}' has no execute function.`, true);
        const output = await execute(args, {
          toolCallId: String(extra.requestId),
          messages: [],
          abortSignal: extra.signal,
        });
        return textResult(stringifyOutput(output));
      } catch (error) {
        return textResult(`Tool '${tool.name}' failed: ${errorMessage(error)}`, true);
      }
    }
  );
}

/**
 * Builds an `McpServer` exposing the agent tool plus the directly exposed
 * tools. Async because `@modelcontextprotocol/sdk` is loaded on first use,
 * not when the SDK is imported (LOU-D19).
 */
export async function buildServer(spec: ServerSpec): Promise<McpServer> {
  const { McpServer } = await loadOptionalPeer('@modelcontextprotocol/sdk', () =>
    import('@modelcontextprotocol/sdk/server/mcp.js')
  );
  const server = new McpServer({ name: spec.name, version: spec.version });
  registerAgentTool(server, spec);
  for (const tool of spec.tools) {
    if (needsApprovalGate(tool) && !spec.allowApprovalTools) continue;
    registerDirectTool(server, tool);
  }
  return server;
}
