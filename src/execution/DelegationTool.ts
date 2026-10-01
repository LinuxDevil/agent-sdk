/**
 * Delegation Tool
 * Wraps a child agent as a ToolDescriptor so a parent agent can delegate
 * a subtask to it via ordinary tool-calling.
 */

import { z } from 'zod';
import { tool } from 'ai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AgentExecutor, PropagatingToolError } from './AgentExecutor';
import { LLMProvider, Message } from '../providers';
import { AgentConfig, ToolDescriptor } from '../types';
import { ToolRegistry } from '../tools';
import type { ToolRunContext } from './sandboxGuard';

/**
 * Thrown when a delegation chain exceeds the configured maxDepth without
 * ever bottoming out (e.g. an A -> B -> A cycle). Prevents infinite
 * recursion / stack overflow from a runaway delegate chain.
 */
export class DelegationDepthExceededError extends PropagatingToolError {
  constructor(maxDepth: number) {
    super(`Delegation depth exceeded maximum of ${maxDepth}`);
    this.name = 'DelegationDepthExceededError';
  }
}

/**
 * Tracks how many delegate-tool hops deep the current async call chain is.
 *
 * Depth cannot be tracked as a closure variable local to a single
 * createDelegateTool() call: in an A -> B -> A chain, agent A's delegate
 * tool and agent B's delegate tool are two *separate* createDelegateTool()
 * instances (each with its own closure), so a local counter on either one
 * would reset to 0 the moment control re-enters "A" via B's tool call and
 * never observe that this is actually the second hop through A.
 *
 * Instead we use a single module-scoped AsyncLocalStorage that holds the
 * current depth for whatever async call chain is executing. Every
 * createDelegateTool() instance reads/writes the *same* store, so depth is
 * shared across the whole chain regardless of how many distinct delegate
 * tools (and therefore closures) participate: each execute() reads the
 * ambient depth, checks it against its own maxDepth, then re-enters
 * AgentExecutor.execute() for the child agent inside
 * delegationDepthStorage.run(depth + 1, ...) - so any delegate tool the
 * child agent goes on to call (including a tool that loops back to an
 * ancestor agent) observes the incremented depth automatically, via
 * Node's native async-context propagation, without any explicit
 * parameter-threading through tool call arguments (which would also be
 * spoofable by the calling LLM).
 */
const delegationDepthStorage = new AsyncLocalStorage<number>();

/**
 * Options for creating a delegate-agent tool.
 */
export interface DelegateAgentOptions {
  agent: AgentConfig;
  provider: LLMProvider;
  toolRegistry?: ToolRegistry;
  /**
   * 'none' (default): the child agent only sees the delegated task as a
   * fresh user message - no shared history with the parent.
   * 'full-history': the child agent additionally sees whatever
   * conversation history is passed via the tool's `context` parameter,
   * with the task appended as the final user message.
   */
  contextMode?: 'none' | 'full-history';
  maxSteps?: number;
  /**
   * Maximum number of hops allowed in a delegation chain before a
   * DelegationDepthExceededError is thrown. Defaults to 3.
   */
  maxDepth?: number;
}

/**
 * Result of a delegated task execution.
 */
export interface DelegateAgentResult {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Create a ToolDescriptor that lets an agent delegate a task to a child
 * agent, running the child through AgentExecutor.execute() and returning
 * its final text/usage.
 */
export function createDelegateTool(opts: DelegateAgentOptions): ToolDescriptor {
  const maxDepth = opts.maxDepth ?? 3;

  return {
    displayName: `Delegate to ${opts.agent.name}`,
    tool: tool({
      description: `Delegates a task to the "${opts.agent.name}" agent and returns its response.`,
      parameters: z.object({
        task: z.string().describe('The task/instructions to delegate to the child agent'),
        context: z
          .array(
            z.object({
              role: z.enum(['system', 'user', 'assistant', 'tool']),
              content: z.string(),
            })
          )
          .optional()
          .describe(
            'Optional prior conversation history to share with the child agent (only used when contextMode is "full-history")'
          ),
      }),
      execute: async (
        {
          task,
          context,
        }: {
          task: string;
          context?: Message[];
        },
        options?: { abortSignal?: AbortSignal } & ToolRunContext
      ): Promise<DelegateAgentResult> => {
        const currentDepth = delegationDepthStorage.getStore() ?? 0;

        if (currentDepth >= maxDepth) {
          throw new DelegationDepthExceededError(maxDepth);
        }

        const childInput: Message[] =
          opts.contextMode === 'full-history' && context
            ? [...context, { role: 'user', content: task }]
            : [{ role: 'user', content: task }];

        return delegationDepthStorage.run(currentDepth + 1, async () => {
          const result = await AgentExecutor.execute({
            agent: opts.agent,
            input: childInput,
            provider: opts.provider,
            toolRegistry: opts.toolRegistry,
            maxSteps: opts.maxSteps,
            // LOU-V1: aborting the parent run aborts the child with it.
            signal: options?.abortSignal,
          });

          // LOU-V5: the child's full usage rolls up into the parent run's
          // totals (`usage.delegated`); the model only sees the token counts.
          options?.onDelegatedUsage?.(result.usage);
          const { promptTokens, completionTokens, totalTokens } = result.usage;
          return {
            text: result.text,
            usage: { promptTokens, completionTokens, totalTokens },
          };
        });
      },
    }),
  };
}
