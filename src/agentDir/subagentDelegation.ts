/**
 * The delegation half of agent-directory sub-agents (Eve MA-F5), with no Node
 * builtins so the Cloudflare Worker runtime (src/deploy/runtime.worker.ts)
 * wires a bundled directory's `subagents/` the same way `loadAgentDir()` does:
 * native sub-agents behind a `delegate_to_<name>` alias, and the lead's
 * approver routing each sub-agent's paused calls to that sub-agent's own.
 */
import { z } from 'zod';
import type { SimpleAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { SDKError } from '../execution/errors';
import { runSubagent } from '../execution/delegation';
import type { ExecutionResult } from '../execution/AgentExecutor';
import { subagentBudget, toolCallScopeOf } from '../execution/subagentRuntime';
import { isPropagatingToolError } from '../execution/propagatingToolError';
import { subagentCallerOf, subagentSpecOf } from '../subagents/withSubagents';
import { toolFailure } from '../tools/built-in/toolFailure';
import type { ApproveToolCall } from '../createAgentApprovals';

/** A sub-agent directory that was resolved into a running agent. */
export interface LoadedSubagent {
  name: string;
  description: string;
  agent: SimpleAgent;
  /** The sub-agent directory's own approver (as assembled, receipt rules included): it decides the sub-agent's calls. */
  approve?: ApproveToolCall;
  /** How many levels of sub-agent directories this one and its descendants span (1: it has none of its own). */
  depth: number;
}

/**
 * `delegate_to_<name>`: the backward-compatible alias of the `task` tool for
 * one sub-agent directory (Eve MA-F5). It runs the sub-agent through the same
 * delegation core as `task` (`runSubagent()`), so the child inherits the lead
 * run's permissions, approvals (a paused child pauses the lead), hooks, events
 * and tracing, and its usage rolls up into the lead's. It returns the
 * sub-agent's final text (its `output` object as JSON when it has one).
 */
export function delegateTool(subagent: LoadedSubagent): DefinedTool {
  return defineTool({
    name: `delegate_to_${subagent.name}`,
    description: `Delegate a task to the '${subagent.name}' agent. ${subagent.description}`,
    input: z.object({ task: z.string().describe('The complete task for the agent, with all needed context') }),
    execute: async ({ task }, ctx) => {
      const scope = toolCallScopeOf(ctx);
      if (scope && subagentBudget(scope.runtime.maxSubagentDepth) <= 0) {
        throw toolFailure(`The '${subagent.name}' agent cannot be started here: this run is at its sub-agent depth limit (maxSubagentDepth).`);
      }
      const registered = subagentSpecOf(subagent.agent);
      if (!registered) {
        throw new SDKError(`loadAgentDir: sub-agent '${subagent.name}' is not an agent created with createAgent().`, 'LOUSHO_CONFIG_INVALID');
      }
      let result: ExecutionResult;
      try {
        const spec = typeof registered === 'function' ? await registered(task, subagentCallerOf(ctx)) : registered;
        result = await runSubagent(spec, { name: subagent.name, input: [{ role: 'user', content: task }], toolOptions: ctx });
      } catch (error) {
        // A paused child pauses the lead run; on resume this call is re-entered and continues the child.
        if (isPropagatingToolError(error)) throw error;
        throw toolFailure(`The '${subagent.name}' agent failed: ${(error as Error | undefined)?.message ?? String(error)}`, error);
      }
      if (result.finishReason !== 'stop' && result.finishReason !== 'length') {
        const last = result.text ? ` Its last text: ${result.text}` : '';
        throw toolFailure(`The '${subagent.name}' agent ended with finish reason '${result.finishReason}' without a final answer.${last}`);
      }
      return result.object === undefined ? result.text : JSON.stringify(result.object);
    },
  });
}

/**
 * The lead's approver once its sub-agent directories run as native
 * sub-agents (Eve MA-F5): a sub-agent's paused call (`subagentPath[0]` is a
 * directory sub-agent) is decided by that sub-agent's own approver - which
 * routes its own sub-agents the same way and keeps receipt-enforced calls for
 * the host - else by the host's in-code approver, else it waits for a human
 * (`agent.approvals.resolve()`). The lead's own calls go to `own`.
 * Undefined when nothing would decide anything.
 */
export function routeSubagentApprovals(
  own: ApproveToolCall | undefined,
  subagents: readonly LoadedSubagent[],
  host: ApproveToolCall | undefined
): ApproveToolCall | undefined {
  const routed = new Map(subagents.filter((s) => s.approve !== undefined || host !== undefined).map((s) => [s.name, s.approve]));
  if (routed.size === 0) return own;
  return (request) => {
    const [first, ...rest] = request.subagentPath ?? [];
    if (first === undefined || !routed.has(first)) return own === undefined ? 'defer' : own(request);
    const approve = routed.get(first);
    if (approve === undefined) return host === undefined ? 'defer' : host(request);
    const { subagentPath: _path, ...call } = request;
    return approve(rest.length > 0 ? { ...call, subagentPath: rest } : call);
  };
}

/** The `maxSubagentDepth` a tree of sub-agent directories needs to run end to end, when it is more than the default 1. */
export function subagentTreeDepth(levels: readonly number[]): number | undefined {
  const deepest = Math.max(0, ...levels);
  return deepest > 1 ? deepest : undefined;
}
