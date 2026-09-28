/**
 * Delegation Tool
 * Wraps a child agent as a ToolDescriptor so a parent agent can delegate
 * a subtask to it via ordinary tool-calling.
 */

import { z } from 'zod';
import { tool } from 'ai';
import { AgentExecutor } from './AgentExecutor';
import { LLMProvider } from '../providers';
import { AgentConfig, ToolDescriptor } from '../types';
import { ToolRegistry } from '../tools';

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
   */
  contextMode?: 'none' | 'full-history';
  maxSteps?: number;
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
  return {
    displayName: `Delegate to ${opts.agent.name}`,
    tool: tool({
      description: `Delegates a task to the "${opts.agent.name}" agent and returns its response.`,
      parameters: z.object({
        task: z.string().describe('The task/instructions to delegate to the child agent'),
      }),
      execute: async ({ task }: { task: string }): Promise<DelegateAgentResult> => {
        const result = await AgentExecutor.execute({
          agent: opts.agent,
          input: [{ role: 'user', content: task }],
          provider: opts.provider,
          toolRegistry: opts.toolRegistry,
          maxSteps: opts.maxSteps,
        });

        return {
          text: result.text,
          usage: result.usage,
        };
      },
    }),
  };
}
