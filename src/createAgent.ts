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
import { withFallback, withRetry, type WithRetryOptions } from './providers/resilience';
import type { DefinedTool } from './tools/defineTool';
import { ToolConcurrency, assertToolConcurrency } from './execution/toolBatch';
import type { Skill } from './skills/defineSkill';
import type { Message } from './providers/llm';
import { AgentSession, withDefaultStores, type SessionOptions, type SessionTurnCheckpoint } from './session/AgentSession';
import type { AgentStore } from './storage/agentStore';
import { loadProjectInstructions } from './projectInstructions';
import { basename } from 'node:path';
import type { Subagents } from './subagents/types';
import type { SubagentOptions } from './subagents/backgroundTasks';
import { assertMaxSubagentDepth, assertNoTaskTool, assertSubagents, registerSubagent, subagentsWithOptions } from './subagents/withSubagents';
import type { SubagentSpec } from './execution/delegation';
import type { ApprovalStore } from './execution/ApprovalGate';
import { InMemoryApprovalStore } from './execution/InMemoryApprovalStore';
import { resumeAfterApproval } from './execution/resume';
import { ConfigurationError } from './execution/errors';
import { createAgentApprovals, type AgentApprovals, type ApproveToolCall } from './createAgentApprovals';
import type { z } from 'zod';
import type { McpServerSpec } from './spec/schema';
import { agentMcp, streamAfter } from './tools/mcp/agentMcp';

/**
 * Options for createAgent() that do not depend on how the instructions and
 * model are given. Tools are keyed by the name the agent (and
 * AgentConfig.tools) will refer to them by - createAgent() registers each
 * one into a fresh ToolRegistry under that key.
 */
export interface CreateAgentBase<TOutput extends z.ZodTypeAny = z.ZodTypeAny> {
  /**
   * Optional tools: an array of `defineTool()` results (named by the tool),
   * or a record of descriptors keyed by the name the agent should call them by.
   *
   * @example
   * createAgent({ prompt: '...', provider, tools: [sendEmail] });
   */
  tools?: readonly DefinedTool[] | Record<string, ToolDescriptor>;
  /**
   * MCP servers to connect (LOU-Z4), keyed by name: stdio `{ command, args?, env? }`
   * or HTTP `{ url, headers? }`. Connected on `agent.ready()` or the first
   * `send()` / `stream()`; their tools are named `<server>__<tool>`. A server
   * that fails to connect fails that call. `agent.close()` disconnects them.
   *
   * @example
   * ```ts
   * const agent = createAgent({ model: 'openai/gpt-4o-mini', mcpServers: { docs: { url: 'https://example.com/mcp' } } });
   * ```
   */
  mcpServers?: Record<string, McpServerSpec>;
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
   * Background sub-agent options (LOU-Y4.2): `maxConcurrent` (default 3) and
   * `awaitBackgroundOnFinish` (default `false`: tasks still running when a
   * run ends are cancelled). Override those set with `withSubagentOptions()`.
   */
  subagentOptions?: SubagentOptions;
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
   * Where the agent keeps sessions, checkpoints and approvals, in one option
   * (LOU-D30): a `SqliteStore`, `memoryStore()`, or any `AgentStore`.
   * `agent.session({ id })` keeps its transcript in `store.sessions` and
   * checkpoints every turn in `store.checkpoints`; `store.approvals` is the
   * default `approvalStore`; `send()` / `stream()` with a `sessionId` are
   * checkpointed in `store.checkpoints`, and `agent.resume(id)` finishes an
   * interrupted run or session turn. Per-call options win over it.
   *
   * @example
   * ```ts
   * const agent = createAgent({ model: 'openai/gpt-4o-mini', store: new SqliteStore('./.loushy/agent.db') });
   * ```
   */
  store?: AgentStore;
  /**
   * Where a run that hits a `needsApproval` tool saves its pause (LOU-D21).
   * Defaults to `store.approvals`, else a new `InMemoryApprovalStore` per
   * agent; pass a durable store (e.g. `SqliteStore.approvals`) to resolve
   * after a restart. Decide pauses with `agent.approvals.resolve()`.
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
  /**
   * Retries of a failed model call (LOU-V7.2), with `withRetry()`: rate
   * limits, timeouts, network errors and 5xx responses, with exponential
   * backoff. Defaults to `{ maxRetries: 2 }` for every model given as a
   * `provider/model` string (resolved with the `ai` SDK's own retries off, so
   * this is the only retry layer); `false` turns retries off. A `provider`
   * instance you pass is wrapped only when you set `retry`. `stream()`
   * reports each retry as a `provider.retry` event.
   *
   * @example
   * ```ts
   * createAgent({ model: 'openai/gpt-4o-mini', retry: { maxRetries: 4, backoff: { initialMs: 1000 } } });
   * ```
   */
  retry?: WithRetryOptions | false;
  /**
   * `provider/model` strings tried in order when the primary model's call
   * still fails after its retries (LOU-V7.2), each resolved like `model` and
   * retried with `retry`. Every call starts with the primary. `stream()`
   * reports each switch as a `provider.fallback` event.
   *
   * @example
   * ```ts
   * createAgent({ model: 'openai/gpt-4o-mini', fallbackModels: ['anthropic/claude-3-5-haiku-latest'] });
   * ```
   */
  fallbackModels?: readonly string[];
  /**
   * A zod schema for the agent's final reply (LOU-V4): the model is asked
   * to answer with a JSON object matching it, and `send()` / `stream()`
   * resolve with it parsed and validated as `result.object`, typed
   * `z.output<typeof output>` (`result.text` keeps the raw JSON). An invalid
   * reply gets one repair step; still invalid, the run ends with
   * `finishReason: 'output-invalid'` and `outputError`. See
   * docs/structured-output.md and `ExecuteOptions.output`.
   *
   * @example
   * ```ts
   * const agent = createAgent({ model: 'openai/gpt-4o-mini', output: z.object({ city: z.string(), tempC: z.number() }) });
   * const { object } = await agent.send('Weather in Paris?');
   * ```
   */
  output?: TOutput;
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
export type CreateAgentConfig<TOutput extends z.ZodTypeAny = z.ZodTypeAny> = CreateAgentBase<TOutput> &
  CreateAgentInstructions &
  CreateAgentModelSource;

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
  /**
   * Makes this a durable run (LOU-D30): it is checkpointed under this id in
   * the agent's `store.checkpoints` after every model response and tool
   * result, and `agent.resume(sessionId)` finishes it after a crash. Calling
   * again with the same id continues the conversation. Needs
   * `createAgent({ store })` with `checkpoints`. See `ExecuteOptions.sessionId`.
   *
   * @example
   * ```ts
   * const result = await agent.send('Run the import.', { sessionId: 'job-1' });
   * ```
   */
  sessionId?: string;
}

/** `TObject`: the type of `result.object` - `z.output` of the `output` schema. */
export interface SimpleAgent<TObject = unknown> {
  /** Send a single user message and get back the full execution result text. */
  send: (message: string, options?: SendOptions) => Promise<ExecutionResult<TObject>>;
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
  stream: (message: string, options?: SendOptions) => AgentRun<TObject>;
  /**
   * Start a multi-turn conversation (LOU-W4): every `send()` sees the earlier
   * exchanges. Kept in the agent's `store` (in memory without one); pass
   * `{ id, store }` (e.g. a `FileSessionStore`) to persist it elsewhere.
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
   * Finishes what was interrupted under `sessionId` (LOU-D30), from the
   * agent's `store.checkpoints`: a `send(message, { sessionId })` run, or
   * else the pending turn of the session with that id (as
   * `agent.session({ id }).resume()`). Resolves with its result, or `null`
   * when nothing is pending. Throws `SessionAwaitingApprovalError` when the
   * run waits on an approval: decide it with `agent.approvals.resolve()`.
   *
   * @example
   * ```ts
   * const finished = await agent.resume('job-1'); // null when nothing was interrupted
   * ```
   */
  resume: (sessionId: string, options?: { signal?: AbortSignal }) => Promise<ExecutionResult<TObject> | null>;
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
  /**
   * Connects the `mcpServers` and registers their tools (LOU-Z4); `send()`
   * and `stream()` await it. Resolves at once without `mcpServers`.
   */
  ready: () => Promise<void>;
  /** Disconnects the `mcpServers` (a later tool call reconnects); a no-op without them. */
  close: () => Promise<void>;
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
export function createAgent<TOutput extends z.ZodTypeAny = z.ZodUnknown>(
  config: CreateAgentConfig<TOutput> = {}
): SimpleAgent<z.output<TOutput>> {
  assertToolConcurrency(config.toolConcurrency, 'createAgent');
  assertMaxSubagentDepth(config.maxSubagentDepth, 'createAgent');
  assertSubagents(config.subagents, 'createAgent');
  const instructions = withProjectInstructions(resolveInstructions(config), config.projectInstructions);
  const provider = resolveModelSource(config);

  const hasMcp = Object.keys(config.mcpServers ?? {}).length > 0;
  const { toolRegistry, toolsConfig } = registerTools(config.tools ?? {}, hasMcp);
  // LOU-Z4: MCP tools join the registry and the agent's tools once connected.
  const mcp = agentMcp(config.mcpServers, (tools) => {
    for (const [name, descriptor] of Object.entries(tools)) {
      toolRegistry?.register(name, descriptor);
      toolsConfig[name] = { tool: name };
    }
  });
  const startStream = (options: ExecuteOptions) =>
    hasMcp ? streamAfter(mcp.ready, options) : AgentExecutor.stream(options);

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
    subagents: subagentsWithOptions(config.subagents, config.subagentOptions),
    maxSubagentDepth: config.maxSubagentDepth,
    maxSteps: config.maxSteps,
    toolConcurrency: config.toolConcurrency,
  };
  const spec: SubagentSpec = { agent, provider, toolRegistry, ...runOptions };
  const checkpoints = config.store?.checkpoints;
  const approvals = createAgentApprovals({
    store: config.approvalStore ?? config.store?.approvals ?? new InMemoryApprovalStore(),
    approve: config.approve,
    resume: (approvalStore, decision, signal, checkpointStore) =>
      resumeAfterApproval(
        decision,
        approvalStore,
        toolRegistry ?? new ToolRegistry(),
        provider,
        { ...runOptions, output: config.output, approvalStore, signal },
        // A run paused under a `sessionId` keeps checkpointing after the decision.
        checkpointStore ?? checkpoints
      ),
  });
  /** A run under `sessionId`, checkpointed in the agent's store (LOU-D30). */
  const durable = (sessionId: string | undefined): Partial<SessionTurnCheckpoint> => {
    if (sessionId === undefined) return {};
    if (!checkpoints) {
      throw new ConfigurationError(
        `createAgent: a run with sessionId '${sessionId}' needs a checkpoint store - ` +
          'pass createAgent({ store }) with `checkpoints` (e.g. a SqliteStore or memoryStore()).',
        'store',
        'LOUSHY_CONFIG_MISSING_CHECKPOINT_STORE'
      );
    }
    return { sessionId, checkpointStore: checkpoints };
  };
  const executeOptions = (
    input: string | Message[],
    signal?: AbortSignal,
    turn?: Partial<SessionTurnCheckpoint>
  ): ExecuteOptions => ({
    ...spec,
    output: config.output,
    approvalStore: approvals.store,
    input,
    signal,
    ...turn,
  });
  const run = async (input: string | Message[], signal?: AbortSignal, turn?: Partial<SessionTurnCheckpoint>) => {
    await mcp.ready();
    return AgentExecutor.execute(executeOptions(input, signal, turn));
  };
  // LOU-W9: a checkpointed session's turn runs under its own sessionId + checkpointStore.
  const session = (options?: SessionOptions): AgentSession =>
    approvals.session(
      run,
      (input, signal, turn) => startStream(executeOptions(input, signal, turn)),
      withDefaultStores(options, config.store)
    );

  // `object` was validated with `config.output`, so it has its output type.
  type Typed = z.output<TOutput>;
  const simpleAgent: SimpleAgent<Typed> = {
    async send(message: string, options: SendOptions = {}): Promise<ExecutionResult<Typed>> {
      const result = await run(message, options.signal, durable(options.sessionId));
      return approvals.settle(result, options.signal) as Promise<ExecutionResult<Typed>>;
    },
    stream(message: string, options: SendOptions = {}): AgentRun<Typed> {
      return startStream(executeOptions(message, options.signal, durable(options.sessionId))) as AgentRun<Typed>;
    },
    session,
    async resume(sessionId: string, { signal } = {}): Promise<ExecutionResult<Typed> | null> {
      const checkpoint = await checkpoints?.load(sessionId);
      // No run under this id: it names a session, whose turns are checkpointed under `<id>.turn-<n>`.
      if (!checkpoint) return session({ id: sessionId }).resume({ signal }) as Promise<ExecutionResult<Typed> | null>;
      if (checkpoint.status === 'finished') return null;
      return approvals.settle(await run([], signal, durable(sessionId)), signal) as Promise<ExecutionResult<Typed>>;
    },
    approvals: approvals.approvals,
    ready: mcp.ready,
    close: mcp.close,
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
    throw new ConfigurationError(
      "createAgent: both 'instructions' and 'prompt' were given. They are the same option - " +
        "use 'instructions' (and drop 'prompt', its alias).",
      'prompt',
      'LOUSHY_CONFIG_CONFLICTING_OPTIONS'
    );
  }
  return config.instructions ?? config.prompt ?? DEFAULT_INSTRUCTIONS;
}

/** The default `retry` for models given as strings: as many retries as the `ai` SDK makes on its own. */
const DEFAULT_RETRY: WithRetryOptions = { maxRetries: 2 };

/**
 * The provider to run with: the given instance, else `model` resolved (else
 * the env's choice), wrapped in `withRetry()` and, with `fallbackModels`,
 * `withFallback()` (LOU-V7.2).
 */
function resolveModelSource(config: CreateAgentConfig): LLMProvider {
  const { retry, fallbackModels = [] } = config;
  const resolve = (spec: string) => {
    // maxRetries: 0 turns off the 'ai' SDK's own retries: withRetry() is the only layer.
    const provider = resolveProviderSpec(spec, 'createAgent', { maxRetries: 0 });
    return retry === false ? provider : withRetry(provider, retry ?? DEFAULT_RETRY);
  };
  let primary: LLMProvider;
  if (config.provider) {
    primary = retry ? withRetry(config.provider, retry) : config.provider;
  } else {
    primary = resolve(config.model ?? modelFromEnv('createAgent'));
  }
  return fallbackModels.length > 0 ? withFallback([primary, ...fallbackModels.map(resolve)]) : primary;
}

/**
 * Registers each tool into a fresh ToolRegistry under its key, and builds
 * the matching AgentConfig.tools entries. No registry is built when there
 * are no tools, unless `alwaysRegistry` (MCP tools are added later).
 */
function registerTools(
  tools: readonly DefinedTool[] | Record<string, ToolDescriptor>,
  alwaysRegistry = false
): {
  toolRegistry: ToolRegistry | undefined;
  toolsConfig: Record<string, { tool: string }>;
} {
  const entries: Array<[string, ToolDescriptor | DefinedTool]> = Array.isArray(tools)
    ? (tools as readonly DefinedTool[]).map((t): [string, DefinedTool] => [t.name, t])
    : Object.entries(tools as Record<string, ToolDescriptor>);
  const toolsConfig: Record<string, { tool: string }> = {};

  if (entries.length === 0 && !alwaysRegistry) {
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
