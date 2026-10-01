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
import { streamResumed, type AgentRun } from './execution/agentRun';
import { LLMProvider } from './providers/llm';
import { ToolRegistry } from './tools/ToolRegistry';
import { ToolDescriptor } from './types';
import { modelFromEnv, resolveProviderSpec } from './providers/providerSpec';
import { withFallback, withRetry, type WithRetryOptions } from './providers/resilience';
import type { DefinedTool } from './tools/defineTool';
import { withAskQuestion } from './tools/built-in/askQuestion';
import { ToolConcurrency, assertToolConcurrency } from './execution/toolBatch';
import type { Skill } from './skills/defineSkill';
import type { Message } from './providers/llm';
import {
  AgentSession,
  withDefaultStores,
  type SessionOptions,
  type SessionTurnCall,
  type SessionTurnCheckpoint,
  type SessionTurnOptions,
} from './session/AgentSession';
import type { AgentStore } from './storage/agentStore';
import { loadProjectInstructions } from './projectInstructions';
import { basename } from 'node:path';
import type { Subagents } from './subagents/types';
import type { SubagentOptions } from './subagents/backgroundTasks';
import { assertMaxSubagentDepth, assertNoTaskTool, assertSubagents, registerSubagent, subagentsWithOptions } from './subagents/withSubagents';
import type { SubagentSpec } from './execution/delegation';
import type { ApprovalDecision, ApprovalStore, ResolvedApproval } from './execution/ApprovalGate';
import { InMemoryApprovalStore } from './execution/InMemoryApprovalStore';
import { resumeRequest, type ResumeRequest } from './execution/resume';
import { RUN_CONFIG_KEY, type CheckpointStore, type ForkOptions, type ForkResult } from './execution/checkpoint';
import type { AgentDriftMode } from './execution/agentFingerprint';
import { ConfigurationError, SDKError } from './execution/errors';
import { newId } from './utils/id';
import { createAgentApprovals, type AgentApprovals, type ApproveToolCall } from './createAgentApprovals';
import type { PermissionOptions } from './execution/permissions';
import type { z } from 'zod';
import type { McpServerSpec } from './spec/schema';
import { agentMcp, streamAfter, streamPrepared } from './tools/mcp/agentMcp';
import { HookRegistry, type AgentHook } from './execution/hooks';
import { toMessages, type AgentInput } from './providers/content';
import { compactionHookFor, type AgentCompaction } from './context/agentCompaction';
import type { MemorySlot } from './memory/defineMemory';
import { agentMemory } from './memory/withMemory';
import type { RunLimits } from './execution/budget';
import type { AgentGuardrails } from './execution/ioGuardrails';

/** What a `model` / `instructions` / `tools` function gets (LOU-V15): the run it is resolved for. */
export interface RunConfigContext {
  /** `send()` / `stream()`'s `sessionId`, or the `agent.session()` id. */
  sessionId?: string;
  /** The run's user input, as given to `send()` / `stream()`. */
  input: AgentInput;
  /** The call's `metadata` option. */
  metadata?: Record<string, unknown>;
}

/**
 * A static value, or a function of the run (LOU-V15), resolved once when the
 * run starts (each session turn resolves again). See docs/api-overview.md.
 *
 * @example
 * ```ts
 * const model: PerRun<string> = ({ metadata }) => (metadata?.plan === 'pro' ? 'openai/gpt-4o' : 'openai/gpt-4o-mini');
 * ```
 */
export type PerRun<T> = T | ((ctx: RunConfigContext) => T | Promise<T>);

/** The `tools` option's static form. */
type AgentToolsOption = readonly DefinedTool[] | Record<string, ToolDescriptor>;

/**
 * Options for createAgent() that do not depend on how the instructions and
 * model are given. Tools are keyed by the name the agent (and
 * AgentConfig.tools) will refer to them by - createAgent() registers each
 * one into a fresh ToolRegistry under that key.
 */
export interface CreateAgentBase<TOutput extends z.ZodTypeAny = z.ZodTypeAny> extends PermissionOptions {
  /**
   * Optional tools: an array of `defineTool()` results (named by the tool),
   * or a record of descriptors keyed by the name the agent should call them by.
   * A function of the run picks them per run (LOU-V15, see `PerRun`).
   *
   * @example
   * createAgent({ prompt: '...', provider, tools: [sendEmail] });
   */
  tools?: PerRun<AgentToolsOption>;
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
   * Budgets of each run (LOU-V6): `maxTokens`, `maxInputTokens`,
   * `maxOutputTokens`, `maxCostUsd`, `maxDurationMs`, `maxSteps` and
   * `onExceeded`. A tripped limit ends the run with
   * `finishReason: 'budget-exceeded'`; see `ExecuteOptions.limits`. For a
   * budget across a session's turns, use `agent.session({ limits })`.
   *
   * @example
   * ```ts
   * createAgent({ model: 'openai/gpt-4o-mini', limits: { maxTokens: 50_000, maxCostUsd: 0.25 } });
   * ```
   */
  limits?: RunLimits;
  /**
   * Input, output and tool guardrails of each run (LOU-X4). A block ends the
   * run with `finishReason: 'guardrail'` and `result.guardrail`; a rewrite
   * replaces the text. Sub-agents inherit them. See docs/guardrails.md.
   *
   * @example
   * ```ts
   * createAgent({ model: 'openai/gpt-4o-mini', guardrails: { input: [maxLengthGuardrail({ maxChars: 4000 })], output: [regexGuardrail({ name: 'secrets', action: 'rewrite' })] } });
   * ```
   */
  guardrails?: AgentGuardrails;
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
   * LOU-W9.2: what a resume does when this agent differs from the one that
   * paused or crashed the run (another model, tools with other names or
   * input schemas, other instructions): `'warn'` (default) emits an
   * `agent.drift` event and a `console.warn`, then continues; `'error'`
   * rejects with `LOUSHY_AGENT_DRIFT` before any model call or tool runs and
   * leaves the checkpoint and approval as they were; `'ignore'` does nothing.
   * A pending tool call whose tool no longer exists always rejects with
   * `LOUSHY_RESUME_TOOL_MISSING`. See `ExecuteOptions.onAgentDrift`.
   *
   * @example
   * ```ts
   * const agent = createAgent({ prompt: '...', provider, store, onAgentDrift: 'error' });
   * ```
   */
  onAgentDrift?: AgentDriftMode;
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
   * Adds the built-in `ask_question` tool (LOU-X9): the agent can ask the
   * user a question, and the run pauses (like an approval, `kind: 'question'`)
   * until `agent.approvals.answer({ id, answer })`. Off by default.
   */
  askQuestion?: boolean;
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
  /**
   * Hooks run around every model call and tool call (LOU-W3.2), in the order
   * given, before the hook `compaction` installs. See `AgentHook` and
   * docs/api-overview.md. They apply to this agent's runs and to its sub-agents'.
   *
   * @example
   * ```ts
   * createAgent({ prompt: '...', provider, hooks: [{ name: 'audit', preToolCall: (ctx) => console.log(ctx.toolName) }] });
   * ```
   */
  hooks?: readonly AgentHook[];
  /**
   * Keeps long runs under the model's context window (LOU-W3.2): `true`
   * installs `createCompactionHook()` with its defaults (prune old tool
   * results above 90% of the window); an object sets `strategy`,
   * `thresholdPercent`, `contextWindow` and `protectedTokens`, and
   * `summarizer` (a `'provider/model'` string or an `LLMProvider`) selects
   * `twoPhaseStrategy()` with that model. `stream()` reports each compaction
   * as `compaction.start` / `compaction.done` events. See docs/compaction.md.
   *
   * @example
   * ```ts
   * createAgent({ model: 'openai/gpt-4o', compaction: { thresholdPercent: 0.8, summarizer: 'openai/gpt-4o-mini' } });
   * ```
   */
  compaction?: AgentCompaction;
  /**
   * Long-term memory slots (LOU-W6), from `defineMemory()`. On the first
   * model call of each run, a slot recalls its newest items into the system
   * prompt (a `<memory name="...">` block), and the model gets
   * `remember_<name>` / `recall_<name>` tools. `scope: 'session'` keys memory
   * by the session id (`agent.session()`'s id, or `send()`'s `sessionId`).
   * See docs/memory.md.
   *
   * @example
   * ```ts
   * const notes = defineMemory({ name: 'notes', scope: 'global', provider: fileMemory({ dir: './.loushy/memory' }) });
   * createAgent({ model: 'openai/gpt-4o-mini', memory: [notes] });
   * ```
   */
  memory?: readonly MemorySlot[];
}

/**
 * The system prompt. `instructions` is the preferred name; `prompt` is a
 * working alias. Give at most one - both is an error. Omit both for a
 * minimal default ("You are a helpful assistant."). Either may be a function
 * of the run (LOU-V15, see `PerRun`).
 */
export type CreateAgentInstructions =
  | {
      /** System prompt for the agent (preferred name). */
      instructions?: PerRun<string>;
      /** Alias of `instructions`; do not pass both. */
      prompt?: undefined;
    }
  | {
      /** Preferred name of `prompt`; do not pass both. */
      instructions?: undefined;
      /** System prompt for the agent (alias of `instructions`). */
      prompt?: PerRun<string>;
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
 *
 * `model` may be a function of the run (LOU-V15, see `PerRun`) returning
 * what the static form takes; `fallbackModels` and `retry` apply to its value.
 */
export type CreateAgentModelSource =
  | {
      /** A `provider/model` string, e.g. `'openai/gpt-4o-mini'`. */
      model: PerRun<string>;
      provider?: undefined;
    }
  | {
      /** An LLM provider instance (real or mock). */
      provider: LLMProvider;
      /** Per-agent model id sent to `provider`, overriding its default model. */
      model?: PerRun<string>;
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
  /**
   * Passed to memory scope functions (LOU-W6), e.g. `{ userId }` for
   * `scope: ({ metadata }) => \`user:${metadata?.userId}\``, and to
   * `model` / `instructions` / `tools` functions (LOU-V15).
   */
  metadata?: Record<string, unknown>;
}

/** `TObject`: the type of `result.object` - `z.output` of the `output` schema. */
export interface SimpleAgent<TObject = unknown> {
  /**
   * Send a single user message and get back the full execution result text.
   * `message` is a string, content parts (one user message with an image or
   * file, LOU-V12) or a `Message[]` passed through as it is.
   */
  send: (message: AgentInput, options?: SendOptions) => Promise<ExecutionResult<TObject>>;
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
  stream: (message: AgentInput, options?: SendOptions) => AgentRun<TObject>;
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
   * Forks the `sessionId` run at `fromStep` (LOU-D44): `AgentExecutor.fork()`
   * over the agent's `store.checkpoints`, which must keep a history. Continue
   * the fork with `agent.resume(fork.sessionId)`; the original is unchanged.
   *
   * @example
   * ```ts
   * const fork = await agent.fork('job-1', { fromStep: 1, patch: { appendInput: 'Use Celsius.' } });
   * const replayed = await agent.resume(fork.sessionId);
   * ```
   */
  fork: (sessionId: string, options: Omit<ForkOptions, 'sessionId' | 'checkpointStore'>) => Promise<ForkResult>;
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
  const hasMcp = Object.keys(config.mcpServers ?? {}).length > 0;
  const memory = agentMemory(config.memory);
  const mcpTools: Record<string, ToolDescriptor> = {};
  const toolsFor = (tools: AgentToolsOption | undefined): RunTools => {
    const runTools = registerTools(withAskQuestion(tools, config.askQuestion) ?? {}, hasMcp);
    memory?.addTools(runTools.toolsConfig);
    addMcpTools(runTools, mcpTools);
    return runTools;
  };

  const runOptions = {
    // LOU-X2: also used by resumed runs and when this agent is a sub-agent.
    permissions: config.permissions,
    onPermissionDecision: config.onPermissionDecision,
    skills: config.skills,
    // LOU-Y6: `task` conversations are kept in the agent's session store, to be resumed by taskId.
    subagents: subagentsWithOptions(
      config.subagents,
      config.store?.sessions ? { sessions: config.store.sessions, ...config.subagentOptions } : config.subagentOptions
    ),
    maxSubagentDepth: config.maxSubagentDepth,
    maxSteps: config.maxSteps,
    limits: config.limits,
    guardrails: config.guardrails,
    toolConcurrency: config.toolConcurrency,
    onAgentDrift: config.onAgentDrift,
  };
  const specs = agentSpecs(config, toolsFor, runOptions);
  const staticSpec = specs.static;
  if (staticSpec && config.subagents) assertNoTaskTool(staticSpec.agent, staticSpec.toolRegistry);
  // LOU-Z4: MCP tools join the registry and the agent's tools once connected.
  const mcp = agentMcp(config.mcpServers, (tools) => {
    Object.assign(mcpTools, tools);
    if (specs.staticTools) addMcpTools(specs.staticTools, tools);
  });
  const hooks = agentHooks(config);
  const checkpoints = config.store?.checkpoints;
  /** How a paused run continues: with the spec (and, for a dynamic run, the model) it paused with. */
  const resumeRequestFor = async (
    approvalStore: ApprovalStore,
    decision: ApprovalDecision,
    signal?: AbortSignal,
    checkpointStore?: CheckpointStore
  ): Promise<ResumeRequest> => {
    const paused = await pausedRun(specs, approvalStore, decision.id);
    return {
      decision,
      approvalStore: paused.store,
      toolRegistry: paused.spec.toolRegistry ?? new ToolRegistry(),
      provider: paused.spec.provider,
      executeOptions: { ...runOptions, output: config.output, hooks, approvalStore: paused.store, signal, currentAgent: paused.spec.agent },
      // A run paused under a `sessionId` keeps checkpointing after the decision.
      checkpointStore: checkpointStore ?? checkpoints,
    };
  };
  const approvals = createAgentApprovals({
    store: config.approvalStore ?? config.store?.approvals ?? new InMemoryApprovalStore(),
    approve: config.approve,
    resume: async (...args) => resumeRequest(await resumeRequestFor(...args)),
    // LOU-V14: the streamed run's own signal and event sink are wired into the request.
    streamResume: (approvalStore, decision, signal, checkpointStore, inputQueue) =>
      streamResumed(async (wire) => {
        const request = await resumeRequestFor(approvalStore, decision, undefined, checkpointStore);
        return resumeRequest({ ...request, executeOptions: wire(request.executeOptions ?? {}) });
      }, signal, inputQueue),
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
    spec: SubagentSpec,
    input: Message[],
    ctx: RunConfigContext,
    signal?: AbortSignal,
    turn?: SessionTurnOptions
  ): ExecuteOptions => ({
    ...spec,
    output: config.output,
    hooks,
    approvalStore: approvals.store,
    input,
    signal,
    ...turn,
    // LOU-W6: memory tools and recall bound to this run's scope keys.
    ...memory?.forRun({ sessionId: ctx.sessionId, metadata: ctx.metadata }, spec.toolRegistry, hooks),
  });
  /**
   * The run's options once MCP servers are connected, with its spec resolved for `ctx` (LOU-V15). A dynamic run
   * restarted from its checkpoint resolves with the `ctx` and model it began with (LOU-V15.2).
   */
  const prepare = async (input: Message[], ctx: RunConfigContext, signal?: AbortSignal, turn?: SessionTurnOptions) => {
    await mcp.ready();
    if (staticSpec) return executeOptions(staticSpec, input, ctx, signal, turn);
    const pinned = await checkpointedRunConfig(turn);
    return executeOptions(await specs.resolve(pinned?.ctx ?? ctx, pinned), input, pinned?.ctx ?? ctx, signal, turn);
  };
  const run = async (input: Message[], ctx: RunConfigContext, signal?: AbortSignal, turn?: SessionTurnOptions) =>
    AgentExecutor.execute(await prepare(input, ctx, signal, turn));
  const stream = (input: Message[], ctx: RunConfigContext, signal?: AbortSignal, turn?: SessionTurnOptions): AgentRun => {
    if (!staticSpec) return streamPrepared(() => prepare(input, ctx, signal, turn), signal, turn?.inputQueue);
    const options = executeOptions(staticSpec, input, ctx, signal, turn);
    return hasMcp ? streamAfter(mcp.ready, options) : AgentExecutor.stream(options);
  };
  // LOU-W9: a checkpointed session's turn runs under its own sessionId + checkpointStore.
  const session = (options: SessionOptions = {}): AgentSession => {
    // The id is chosen here so memory scoped to the session sees it on every turn.
    const sessionId = options.id ?? globalThis.crypto.randomUUID();
    const ctxOf = (input: Message[], call?: SessionTurnCall): RunConfigContext => ({
      sessionId,
      input: call?.input ?? input,
      metadata: call?.metadata,
    });
    return approvals.session(
      (input, signal, turn, call) => run(input, ctxOf(input, call), signal, turn),
      (input, signal, turn, call) => stream(input, ctxOf(input, call), signal, turn),
      // LOU-W8 follow-up: `session.compact()` uses the agent's `compaction` unless the session sets its own.
      withDefaultStores({ ...options, compaction: options.compaction ?? config.compaction, id: sessionId }, config.store)
    );
  };

  // `object` was validated with `config.output`, so it has its output type.
  type Typed = z.output<TOutput>;
  const simpleAgent: SimpleAgent<Typed> = {
    async send(message: AgentInput, options: SendOptions = {}): Promise<ExecutionResult<Typed>> {
      const { sessionId, metadata } = options;
      const result = await run(toMessages(message), { sessionId, input: message, metadata }, options.signal, durable(sessionId));
      return approvals.settle(result, options.signal) as Promise<ExecutionResult<Typed>>;
    },
    stream(message: AgentInput, options: SendOptions = {}): AgentRun<Typed> {
      const { sessionId, metadata } = options;
      return stream(toMessages(message), { sessionId, input: message, metadata }, options.signal, durable(sessionId)) as AgentRun<Typed>;
    },
    session,
    async resume(sessionId: string, { signal } = {}): Promise<ExecutionResult<Typed> | null> {
      const checkpoint = await checkpoints?.load(sessionId);
      // No run under this id: it names a session, whose turns are checkpointed under `<id>.turn-<n>`.
      if (!checkpoint) return session({ id: sessionId }).resume({ signal }) as Promise<ExecutionResult<Typed> | null>;
      if (checkpoint.status === 'finished') return null;
      return approvals.settle(await run([], { sessionId, input: [] }, signal, durable(sessionId)), signal) as Promise<ExecutionResult<Typed>>;
    },
    // durable() throws LOUSHY_CONFIG_MISSING_CHECKPOINT_STORE without `store.checkpoints`.
    fork: async (sessionId, options) => AgentExecutor.fork({ ...options, ...(durable(sessionId) as SessionTurnCheckpoint) }),
    approvals: approvals.approvals,
    ready: mcp.ready,
    close: mcp.close,
  };
  // As a sub-agent, a dynamic agent resolves its config with the task prompt as `input`.
  registerSubagent(simpleAgent, { spec: staticSpec ?? ((prompt) => specs.resolve({ input: prompt })), description: config.description });
  return simpleAgent;
}

/** A run's tool registry and the matching `AgentConfig.tools`. */
type RunTools = ReturnType<typeof registerTools>;

/** Adds connected MCP tools (LOU-Z4) to a run's tools. */
function addMcpTools(target: RunTools, tools: Record<string, ToolDescriptor>): void {
  for (const [name, descriptor] of Object.entries(tools)) {
    target.toolRegistry?.register(name, descriptor);
    target.toolsConfig[name] = { tool: name };
  }
}

/** What a paused or interrupted dynamic run is resumed with: its `ctx`, and the model it ran with (never re-resolved). */
interface PinnedRunConfig {
  ctx: RunConfigContext;
  model: string | undefined;
}

/** The `ctx` and model of the unfinished run checkpointed for `turn` (LOU-V15.2), if there is one. */
async function checkpointedRunConfig(turn: SessionTurnOptions | undefined): Promise<PinnedRunConfig | undefined> {
  if (!turn?.sessionId || !turn.checkpointStore) return undefined;
  const checkpoint = await turn.checkpointStore.load(turn.sessionId);
  return checkpoint && checkpoint.status !== 'finished' ? (checkpoint.runConfig as PinnedRunConfig | undefined) : undefined;
}

type RunOptions = Omit<SubagentSpec, 'agent' | 'provider' | 'toolRegistry'> & { onAgentDrift?: AgentDriftMode };

/** The agent's run specs: `static` when no option is a function, else `resolve(ctx)` builds one per run (LOU-V15). */
interface AgentSpecs {
  static?: SubagentSpec;
  /** The tools when `tools` is static: shared by every run, MCP tools are added to them. */
  staticTools?: RunTools;
  resolve: (ctx: RunConfigContext, pinned?: PinnedRunConfig) => Promise<SubagentSpec>;
}

function agentSpecs(config: CreateAgentConfig, toolsFor: (tools: AgentToolsOption | undefined) => RunTools, runOptions: RunOptions): AgentSpecs {
  const instructions = instructionsOption(config);
  const projectBlock = projectInstructionsBlock(config.projectInstructions);
  const provider = isPerRun(config.model) ? undefined : resolveModelSource(config, config.model);
  const staticTools = isPerRun(config.tools) ? undefined : toolsFor(config.tools);
  const agentId = newId();
  const specOf = (prompt: string | undefined, model: string | undefined, runProvider: LLMProvider, tools: RunTools): SubagentSpec => {
    const builder = AgentBuilder.create()
      .setId(agentId)
      .setName(config.name || 'agent')
      .setPrompt((prompt ?? DEFAULT_INSTRUCTIONS) + projectBlock)
      .setTools(tools.toolsConfig);
    // With an explicit provider, `model` is a per-agent model setting.
    if (config.provider && model) builder.setSettings({ model });
    return { agent: builder.build(), provider: runProvider, toolRegistry: tools.toolRegistry, ...runOptions };
  };
  const resolve = async (ctx: RunConfigContext, pinned?: PinnedRunConfig): Promise<SubagentSpec> => {
    const model = pinned ? pinned.model : await resolveOption('model', config.model, ctx);
    const prompt = await resolveOption(config.prompt === undefined ? 'instructions' : 'prompt', instructions, ctx);
    const tools = staticTools ?? toolsFor(await resolveOption('tools', config.tools, ctx));
    const spec = specOf(prompt, model, provider ?? resolveModelSource(config, model), tools);
    spec.agent.metadata = { [RUN_CONFIG_KEY]: { ctx, model } satisfies PinnedRunConfig };
    return spec;
  };
  if (provider && staticTools && !isPerRun(instructions)) {
    return { static: specOf(instructions, config.model as string | undefined, provider, staticTools), staticTools, resolve };
  }
  return { staticTools, resolve };
}

function isPerRun<T>(value: PerRun<T>): value is (ctx: RunConfigContext) => T | Promise<T> {
  return typeof value === 'function';
}

/** `value`, or what its function returns for `ctx`; a throw becomes LOUSHY_CONFIG_RESOLVER_FAILED naming `option`. */
async function resolveOption<T>(option: string, value: PerRun<T>, ctx: RunConfigContext): Promise<T> {
  if (!isPerRun(value)) return value;
  try {
    return await value(ctx);
  } catch (error) {
    throw new ConfigurationError(
      `createAgent: the '${option}' function threw while resolving this run's config: ${error instanceof Error ? error.message : String(error)}`,
      option,
      'LOUSHY_CONFIG_RESOLVER_FAILED',
      { cause: error }
    );
  }
}

/**
 * The spec a paused run resumes with. A dynamic run takes its approval
 * (to read the `ctx` and model it was paused with) and hands it back to
 * `resumeAfterApproval()` through a store that replays it once.
 */
async function pausedRun(specs: AgentSpecs, store: ApprovalStore, id: string): Promise<{ spec: SubagentSpec; store: ApprovalStore }> {
  if (specs.static) return { spec: specs.static, store };
  const record = await store.resolve(id);
  if (!record) {
    throw new SDKError(`No pending approval found for id '${id}' (unknown or already resolved)`, 'LOUSHY_APPROVAL_NOT_FOUND');
  }
  const pinned = record.snapshot.agent.metadata?.[RUN_CONFIG_KEY] as PinnedRunConfig | undefined;
  const spec = await specs.resolve(pinned?.ctx ?? { input: [] }, pinned);
  let replay: ResolvedApproval | undefined = record;
  const replayStore: ApprovalStore = {
    save: (pending, snapshot) => store.save(pending, snapshot),
    async resolve(resolveId) {
      if (replay?.pending.id !== resolveId) return store.resolve(resolveId);
      const once = replay;
      replay = undefined;
      return once;
    },
  };
  return { spec, store: replayStore };
}

/** The agent's hooks: `hooks`, then the one `compaction` installs; `undefined` when there are none. */
function agentHooks({ hooks = [], compaction }: CreateAgentBase): HookRegistry | undefined {
  const compactionHook = compactionHookFor(compaction);
  if (hooks.length === 0 && !compactionHook) return undefined;
  const registry = new HookRegistry();
  registry.registerMany([...hooks, ...(compactionHook ? [compactionHook] : [])]);
  return registry;
}

/** What `projectInstructions` appends to the instructions: the nearest AGENTS.md / CLAUDE.md, or ''. */
function projectInstructionsBlock(option: CreateAgentBase['projectInstructions']): string {
  if (!option) return '';
  const found = loadProjectInstructions(option === true ? {} : option);
  if (!found) return '';
  return `

## Project instructions (from ${basename(found.path)})

${found.content}`;
}

/** Used when neither `instructions` nor `prompt` is given. */
const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

function instructionsOption(config: CreateAgentConfig): PerRun<string> | undefined {
  if (config.instructions !== undefined && config.prompt !== undefined) {
    throw new ConfigurationError(
      "createAgent: both 'instructions' and 'prompt' were given. They are the same option - " +
        "use 'instructions' (and drop 'prompt', its alias).",
      'prompt',
      'LOUSHY_CONFIG_CONFLICTING_OPTIONS'
    );
  }
  return config.instructions ?? config.prompt;
}

/** The default `retry` for models given as strings: as many retries as the `ai` SDK makes on its own. */
const DEFAULT_RETRY: WithRetryOptions = { maxRetries: 2 };

/**
 * The provider to run with: the given instance, else `model` resolved (else
 * the env's choice), wrapped in `withRetry()` and, with `fallbackModels`,
 * `withFallback()` (LOU-V7.2). `model` is the run's (LOU-V15).
 */
function resolveModelSource(config: CreateAgentConfig, model: string | undefined): LLMProvider {
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
    primary = resolve(model ?? modelFromEnv('createAgent'));
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
