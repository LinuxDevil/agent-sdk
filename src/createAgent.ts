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
import { modelFromEnv, resolveProviderSpec } from './providers/providerSpec';
import type { DefinedTool } from './tools/defineTool';

/**
 * Options for createAgent() that do not depend on how the instructions and
 * model are given. Tools are keyed by the name the agent (and
 * AgentConfig.tools) will refer to them by - createAgent() registers each
 * one into a fresh ToolRegistry under that key.
 */
export interface CreateAgentBase {
  /**
   * Optional tools: an array of `defineTool()` results (named by the tool),
   * or a record of descriptors keyed by the name the agent should call them by.
   *
   * @example
   * createAgent({ prompt: '...', provider, tools: [sendEmail] });
   */
  tools?: readonly DefinedTool[] | Record<string, ToolDescriptor>;
  /** Optional agent name; defaults to 'agent'. */
  name?: string;
  /** Optional maxSteps passed through to AgentExecutor.execute(). */
  maxSteps?: number;
}

/**
 * The system prompt. `instructions` is the preferred name; `prompt` is a
 * working alias. Give at most one - both is an error. Omit both for a
 * minimal default ("You are a helpful assistant.").
 */
export type CreateAgentInstructions =
  | {
      /** System prompt for the agent (preferred name). */
      instructions?: string;
      /** Alias of `instructions`; do not pass both. */
      prompt?: undefined;
    }
  | {
      /** Preferred name of `prompt`; do not pass both. */
      instructions?: undefined;
      /** System prompt for the agent (alias of `instructions`). */
      prompt?: string;
    };

/**
 * How the LLM is chosen - exactly one of these alternatives:
 *
 * 1. `model: 'provider/model'` - resolved with `resolveProvider()`, the key
 *    read from the provider's conventional env var (`OPENAI_API_KEY`,
 *    `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or `OLLAMA_BASE_URL`).
 * 2. `provider: <LLMProvider>` - your own (or the mock) provider instance.
 *    You may also pass `model` here (a bare model id, e.g. `'gpt-4o'`): it
 *    becomes this agent's model setting, overriding the provider's default
 *    model.
 * 3. Neither - resolved from the environment: `LOUSHY_MODEL` (a
 *    `provider/model` string) if set, otherwise the first provider whose key
 *    is set, checked in the order OPENAI_API_KEY, ANTHROPIC_API_KEY,
 *    OPENROUTER_API_KEY, OLLAMA_BASE_URL. Throws, listing the fixes, when
 *    none is set.
 */
export type CreateAgentModelSource =
  | {
      /** A `provider/model` string, e.g. `'openai/gpt-4o-mini'`. */
      model: string;
      provider?: undefined;
    }
  | {
      /** An LLM provider instance (real or mock). */
      provider: LLMProvider;
      /** Per-agent model id sent to `provider`, overriding its default model. */
      model?: string;
    }
  | {
      model?: undefined;
      provider?: undefined;
    };

/**
 * Configuration for createAgent(): the common options plus one way to give
 * the instructions and one way to choose the model (see the two unions).
 *
 * @example
 * createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You are a helpful assistant.' });
 */
export type CreateAgentConfig = CreateAgentBase & CreateAgentInstructions & CreateAgentModelSource;

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
 * Build a ready-to-use agent in one call. The smallest useful form is a
 * model string, instructions, and `send()`.
 *
 * See `CreateAgentModelSource` for how the model is chosen (a
 * `provider/model` string, a provider instance, or the environment) and
 * `CreateAgentInstructions` for `instructions` vs its alias `prompt`. Does
 * NOT modify AgentBuilder or AgentExecutor - it is purely a thin
 * composition of the existing public APIs.
 *
 * @example
 * const agent = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'You are a helpful assistant.' });
 * const { text } = await agent.send('Hello!');
 */
export function createAgent(config: CreateAgentConfig = {}): SimpleAgent {
  const instructions = resolveInstructions(config);
  const provider = resolveModelSource(config);

  const { toolRegistry, toolsConfig } = registerTools(config.tools ?? {});

  const builder = AgentBuilder.create()
    .setType(AgentType.SmartAssistant)
    .setName(config.name || 'agent')
    .setPrompt(instructions)
    .setTools(toolsConfig);
  // With an explicit provider, `model` is a per-agent model setting.
  if (config.provider && config.model) builder.setSettings({ model: config.model });
  const agent = builder.build();

  return {
    async send(message: string, options: SendOptions = {}): Promise<ExecutionResult> {
      return AgentExecutor.execute({
        agent,
        input: message,
        provider,
        toolRegistry,
        maxSteps: config.maxSteps,
        signal: options.signal,
      });
    },
  };
}

/** Used when neither `instructions` nor `prompt` is given. */
const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

function resolveInstructions(config: CreateAgentConfig): string {
  if (config.instructions !== undefined && config.prompt !== undefined) {
    throw new Error(
      "createAgent: both 'instructions' and 'prompt' were given. They are the same option - " +
        "use 'instructions' (and drop 'prompt', its alias)."
    );
  }
  return config.instructions ?? config.prompt ?? DEFAULT_INSTRUCTIONS;
}

/** The provider to run with: the given instance, else `model` resolved from env, else the env's choice. */
function resolveModelSource(config: CreateAgentConfig): LLMProvider {
  if (config.provider) return config.provider;
  return resolveProviderSpec(config.model ?? modelFromEnv('createAgent'), 'createAgent');
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
