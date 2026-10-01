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
import { AgentExecutor, ExecuteOptions, ExecutionResult } from './execution/AgentExecutor';
import type { AgentRun } from './execution/agentRun';
import { LLMProvider } from './providers/llm';
import { ToolRegistry } from './tools/ToolRegistry';
import { ToolDescriptor } from './types';
import { modelFromEnv, resolveProviderSpec } from './providers/providerSpec';
import type { DefinedTool } from './tools/defineTool';
import { ToolConcurrency, assertToolConcurrency } from './execution/toolBatch';
import type { Skill } from './skills/defineSkill';
import type { Message } from './providers/llm';
import { AgentSession, type SessionOptions } from './session/AgentSession';
import { loadProjectInstructions } from './projectInstructions';
import { basename } from 'node:path';
import type { Subagents } from './subagents/types';
import { assertMaxSubagentDepth, assertNoTaskTool, assertSubagents, registerSubagent } from './subagents/withSubagents';
import type { SubagentSpec } from './execution/delegation';
import type { ApprovalStore } from './execution/ApprovalGate';
import { InMemoryApprovalStore } from './execution/InMemoryApprovalStore';
import { resumeAfterApproval } from './execution/resume';
import { createAgentApprovals, type AgentApprovals, type ApproveToolCall } from './createAgentApprovals';

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
  /**
   * What this agent does, in a sentence (LOU-Y3). Required when the agent is
   * used as a sub-agent: the lead model reads it to decide which sub-agent
   * gets a task.
   *
   * @example
   * ```ts
   * const researcher = createAgent({ instructions: 'You research...', description: 'Finds and summarizes sources', provider });
   * ```
   */
  description?: string;
  /**
   * Sub-agents this agent can delegate to (LOU-Y3): `createAgent()` agents
   * keyed by name (each with a `description`), or a `{ list, resolve }`
   * catalog. Registers one `task` tool and lists the sub-agents in the system
   * prompt. Each sub-agent sees only the task prompt and runs with its own
   * instructions, model and tools. Several `task` calls in one turn run in
   * parallel. See docs/sub-agents.md.
   *
   * @example
   * ```ts
   * const lead = createAgent({ instructions: 'You coordinate...', provider, subagents: { researcher, writer } });
   * ```
   */
  subagents?: Subagents;
  /**
   * How deep sub-agents may nest. Defaults to 1: this agent's sub-agents
   * cannot call sub-agents of their own (they are not offered the `task`
   * tool). The top-level agent's value applies to the whole tree.
   */
  maxSubagentDepth?: number;
  /** Optional maxSteps passed through to AgentExecutor.execute(). */
  maxSteps?: number;
  /**
   * How many tool calls from one model turn may run at once (LOU-V3).
   * Defaults to `'unbounded'`; `1` runs them one at a time. Results always
   * reach the transcript in the model's call order. See
   * `ExecuteOptions.toolConcurrency` for the full contract.
   *
   * @example
   * ```ts
   * const agent = createAgent({ prompt: '...', provider, tools: [sendEmail], toolConcurrency: 1 });
   * ```
   */
  toolConcurrency?: ToolConcurrency;
  /**
   * Opt in to appending the nearest `AGENTS.md` / `CLAUDE.md` (found by
   * walking up from `cwd`, see `loadProjectInstructions()`) to the agent's
   * instructions, under a `## Project instructions (from AGENTS.md)` heading
   * (LOU-W7). Off by default: the SDK never reads files from disk unless asked.
   * Nothing is added when no file is found. Read once, when the agent is created.
   *
   * @example
   * ```ts
   * createAgent({ prompt: '...', provider, projectInstructions: true });
   * createAgent({ prompt: '...', provider, projectInstructions: { cwd: './packages/api', files: ['AGENTS.md'] } });
   * ```
   */
  projectInstructions?: boolean | { cwd?: string; files?: readonly string[] };
  /**
   * Where a run that hits a `needsApproval` tool saves its pause (LOU-D21).
   * Defaults to a new `InMemoryApprovalStore` per agent; pass a durable store
   * (e.g. `SqliteStore.approvals`) to resolve after a restart. Decide pauses
   * with `agent.approvals.resolve()`.
   */
  approvalStore?: ApprovalStore;
  /**
   * Decides approvals as they come up instead of pausing (LOU-D21): `true`
   * runs the tool, `false` gives the model a rejection. Applies to `send()`,
   * sessions and `agent.approvals.resolve()`; `stream()` still ends at the pause.
   *
   * @example
   * ```ts
   * createAgent({ prompt: '...', provider, tools: [sendEmail], approve: ({ args }) => args.to === 'me@example.com' });
   * ```
   */
  approve?: ApproveToolCall;
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
  /**
   * Send a single user message and stream the run as typed events (LOU-V2):
   * `text.delta` chunks as the model writes, `tool.start`/`tool.done`,
   * step boundaries, and a final `run.done`. Iterate the returned
   * `AgentRun`, or await its `result` (the same `ExecutionResult` `send()`
   * returns). Breaking out of the loop early aborts the run. See
   * docs/streaming.md.
   *
   * @example
   * ```ts
   * for await (const event of agent.stream('Weather in Paris?')) {
   *   if (event.type === 'text.delta') process.stdout.write(event.text);
   * }
   * ```
   */
  stream: (message: string, options?: SendOptions) => AgentRun;
  /**
   * Start a multi-turn conversation (LOU-W4): every `send()` sees the earlier
   * exchanges. In memory by default; pass `{ id, store }` (e.g. a
   * `FileSessionStore`) to persist it and continue it later.
   *
   * @example
   * ```ts
   * const session = agent.session();
   * await session.send('My name is Ali.');
   * const { text } = await session.send('What is my name?');
   * ```
   */
  session: (options?: SessionOptions) => AgentSession;
  /**
   * Tool calls this agent is paused on, waiting for approval (LOU-D21). A
   * paused `send()` resolves with `finishReason: 'awaiting-approval'` and an
   * `approvalId`; `resolve()` runs or rejects the call and continues the run
   * (in its session, if it paused in one).
   *
   * @example
   * ```ts
   * const paused = await agent.send('Email the report to Sam');
   * const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
   * ```
   */
  approvals: AgentApprovals;
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
  assertToolConcurrency(config.toolConcurrency, 'createAgent');
  assertMaxSubagentDepth(config.maxSubagentDepth, 'createAgent');
  assertSubagents(config.subagents, 'createAgent');
  const instructions = withProjectInstructions(resolveInstructions(config), config.projectInstructions);
  const provider = resolveModelSource(config);

  const { toolRegistry, toolsConfig } = registerTools(config.tools ?? {});

  const builder = AgentBuilder.create()
    .setName(config.name || 'agent')
    .setPrompt(instructions)
    .setTools(toolsConfig);
  // With an explicit provider, `model` is a per-agent model setting.
  if (config.provider && config.model) builder.setSettings({ model: config.model });
  const agent = builder.build();
  if (config.subagents) assertNoTaskTool(agent, toolRegistry);

  const runOptions = {
    skills: config.skills,
    subagents: config.subagents,
    maxSubagentDepth: config.maxSubagentDepth,
    maxSteps: config.maxSteps,
    toolConcurrency: config.toolConcurrency,
  };
  const spec: SubagentSpec = { agent, provider, toolRegistry, ...runOptions };
  const approvals = createAgentApprovals({
    store: config.approvalStore ?? new InMemoryApprovalStore(),
    approve: config.approve,
    resume: (approvalStore, decision, signal) =>
      resumeAfterApproval(decision, approvalStore, toolRegistry ?? new ToolRegistry(), provider, {
        ...runOptions,
        approvalStore,
        signal,
      }),
  });
  const executeOptions = (input: string | Message[], signal?: AbortSignal): ExecuteOptions => ({
    ...spec,
    approvalStore: approvals.store,
    input,
    signal,
  });
  const run = (input: string | Message[], signal?: AbortSignal): Promise<ExecutionResult> =>
    AgentExecutor.execute(executeOptions(input, signal));

  const simpleAgent: SimpleAgent = {
    async send(message: string, options: SendOptions = {}): Promise<ExecutionResult> {
      return approvals.settle(await run(message, options.signal), options.signal);
    },
    stream(message: string, options: SendOptions = {}): AgentRun {
      return AgentExecutor.stream(executeOptions(message, options.signal));
    },
    session: (options?: SessionOptions) => approvals.session(run, options),
    approvals: approvals.approvals,
  };
  registerSubagent(simpleAgent, { spec, description: config.description });
  return simpleAgent;
}

/** Appends the nearest AGENTS.md / CLAUDE.md to `instructions` when `projectInstructions` is set. */
function withProjectInstructions(
  instructions: string,
  option: CreateAgentBase['projectInstructions']
): string {
  if (!option) return instructions;
  const found = loadProjectInstructions(option === true ? {} : option);
  if (!found) return instructions;
  return `${instructions}

## Project instructions (from ${basename(found.path)})

${found.content}`;
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
