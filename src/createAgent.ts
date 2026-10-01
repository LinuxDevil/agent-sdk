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
import type { DefinedTool } from './tools/defineTool';
import type { Skill } from './skills/defineSkill';

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
  /**
   * Optional tools: an array of `defineTool()` results (named by the tool),
   * or a record of descriptors keyed by the name the agent should call them by.
   *
   * @example
   * createAgent({ prompt: '...', provider, tools: [sendEmail] });
   */
  tools?: readonly DefinedTool[] | Record<string, ToolDescriptor>;
  /**
   * Optional skills (LOU-Y2): only name + description go in the system
   * prompt; the model loads a skill's full content with the auto-registered
   * `load_skill` tool. Build them with `defineSkill()` or `loadSkills()`.
   *
   * @example
   * createAgent({ prompt: '...', provider, skills: await loadSkills('./skills') });
   */
  skills?: readonly Skill[];
  /** Optional agent name; defaults to 'agent'. */
  name?: string;
  /** Optional maxSteps passed through to AgentExecutor.execute(). */
  maxSteps?: number;
}

/** Per-call options for `SimpleAgent.send()`. */
export interface SendOptions {
  /**
   * Cancels this run (LOU-V1). The returned promise then resolves - it
   * does not reject - with `finishReason: 'aborted'` and the transcript so
   * far. See `ExecuteOptions.signal`.
   *
   * @example
   * ```ts
   * const result = await agent.send('hi', { signal: AbortSignal.timeout(10_000) });
   * ```
   */
  signal?: AbortSignal;
}

export interface SimpleAgent {
  /** Send a single user message and get back the full execution result text. */
  send: (message: string, options?: SendOptions) => Promise<ExecutionResult>;
}

/**
 * Build a ready-to-use agent from a prompt + provider (+ optional tools) in
 * one call. Does NOT modify AgentBuilder or AgentExecutor - it is purely a
 * thin composition of the existing public APIs.
 */
export function createAgent(config: CreateAgentConfig): SimpleAgent {
  assertCreateAgentConfig(config);

  const { toolRegistry, toolsConfig } = registerTools(config.tools ?? {});

  const agent = AgentBuilder.create()
    .setType(AgentType.SmartAssistant)
    .setName(config.name || 'agent')
    .setPrompt(config.prompt)
    .setTools(toolsConfig)
    .build();

  return {
    async send(message: string, options: SendOptions = {}): Promise<ExecutionResult> {
      return AgentExecutor.execute({
        agent,
        input: message,
        provider: config.provider,
        toolRegistry,
        skills: config.skills,
        maxSteps: config.maxSteps,
        signal: options.signal,
      });
    },
  };
}

function assertCreateAgentConfig(config: CreateAgentConfig): void {
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
}

/**
 * Registers each tool into a fresh ToolRegistry under its key, and builds
 * the matching AgentConfig.tools entries. No registry is built when there
 * are no tools.
 */
function registerTools(tools: readonly DefinedTool[] | Record<string, ToolDescriptor>): {
  toolRegistry: ToolRegistry | undefined;
  toolsConfig: Record<string, { tool: string }>;
} {
  const entries: Array<[string, ToolDescriptor | DefinedTool]> = Array.isArray(tools)
    ? (tools as readonly DefinedTool[]).map((t): [string, DefinedTool] => [t.name, t])
    : Object.entries(tools as Record<string, ToolDescriptor>);
  const toolsConfig: Record<string, { tool: string }> = {};

  if (entries.length === 0) {
    return { toolRegistry: undefined, toolsConfig };
  }

  const toolRegistry = new ToolRegistry();
  for (const [name, descriptor] of entries) {
    if (Array.isArray(tools)) {
      toolRegistry.register(descriptor as DefinedTool);
    } else {
      toolRegistry.register(name, descriptor);
    }
    toolsConfig[name] = { tool: name };
  }
  return { toolRegistry, toolsConfig };
}
