/**
 * createAgent() - zero-config, one-liner convenience API (LOU-H1)
 *
 * Wraps AgentBuilder + ToolRegistry + the real static
 * AgentExecutor.execute() behind a minimal `{send}` surface so a caller
 * who just wants "prompt in, text out" doesn't have to learn the full
 * builder/executor/registry API.
 *
 * AgentExecutor is a static, instance-free API (`AgentExecutor.execute(options)`,
 * never `new AgentExecutor()`). Its ExecuteOptions only strictly requires
 * `agent`, `input` and `provider` - repositories (Agent/Session/Result/...)
 * are NOT accepted or required by execute() at all, so createAgent() does
 * not construct or wire any repository/mock-repository implementation.
 * `toolRegistry` is optional too; it's only built when `config.tools` is
 * non-empty.
 */

import { AgentBuilder } from './core/AgentBuilder';
import { AgentType } from './types';
import { AgentExecutor, ExecutionResult } from './execution/AgentExecutor';
import { LLMProvider } from './providers/llm';
import { ToolRegistry } from './tools/ToolRegistry';
import { ToolDescriptor } from './types';

/**
 * Configuration for createAgent(). Tools are keyed by the name the agent
 * (and AgentConfig.tools) will refer to them by - createAgent() registers
 * each one into a fresh ToolRegistry under that key.
 */
export interface CreateAgentConfig {
  /** System prompt for the agent. */
  prompt: string;
  /** LLM provider instance (real or mock) used to generate responses. */
  provider: LLMProvider;
  /** Optional tools, keyed by the name the agent should call them by. */
  tools?: Record<string, ToolDescriptor>;
  /** Optional agent name; defaults to 'agent'. */
  name?: string;
  /** Optional maxSteps passed through to AgentExecutor.execute(). */
  maxSteps?: number;
}

export interface SimpleAgent {
  /** Send a single user message and get back the full execution result text. */
  send: (message: string) => Promise<ExecutionResult>;
}

/**
 * Build a ready-to-use agent from a prompt + provider (+ optional tools) in
 * one call. Does NOT modify AgentBuilder or AgentExecutor - it is purely a
 * thin composition of the existing public APIs.
 */
export function createAgent(config: CreateAgentConfig): SimpleAgent {
  if (!config || !config.provider) {
    throw new Error(
      "createAgent: 'provider' is required. Example: createAgent({ prompt: '...', provider: myProvider })"
    );
  }
  if (!config.prompt) {
    throw new Error(
      "createAgent: 'prompt' is required. Example: createAgent({ prompt: 'You are a helpful assistant', provider: myProvider })"
    );
  }

  const toolNames = config.tools ? Object.keys(config.tools) : [];

  let toolRegistry: ToolRegistry | undefined;
  const toolsConfig: Record<string, { tool: string }> = {};

  if (toolNames.length > 0) {
    toolRegistry = new ToolRegistry();
    for (const name of toolNames) {
      toolRegistry.register(name, config.tools![name]);
      toolsConfig[name] = { tool: name };
    }
  }

  const agent = AgentBuilder.create()
    .setType(AgentType.SmartAssistant)
    .setName(config.name || 'agent')
    .setPrompt(config.prompt)
    .setTools(toolsConfig)
    .build();

  return {
    async send(message: string): Promise<ExecutionResult> {
      return AgentExecutor.execute({
        agent,
        input: message,
        provider: config.provider,
        toolRegistry,
        maxSteps: config.maxSteps,
      });
    },
  };
}
