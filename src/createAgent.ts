/**
 * createAgent() - zero-config, one-liner convenience API
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
import { streamResumed, throwingRun, type AgentRun } from './execution/agentRun';
import type { AgentEvent } from './execution/agentEvents';
import type { TraceExporter } from './execution/tracing';
import { defaultCaptureContent } from './observe/emit';
import { withObserveExporter, type PromptUseProvider } from './observe/reporter';
import { parsePromptRef, registryPrompt } from './observe/promptClient';
import { assertModelSettings, mergeModelSettings } from './execution/modelSettings';
import { assertKnownCreateAgentKeys } from './createAgentKeys';
import { DEFAULT_AGENT_NAME } from './execution/genAiSpans';
import { LLMProvider, LLMProviderRegistry } from './providers/llm';
import { ToolRegistry } from './tools/ToolRegistry';
import { ToolDescriptor } from './types';
import { modelFromEnv, resolveProviderSpec } from './providers/providerSpec';
import { withFallback, withRetry, type WithRetryOptions } from './providers/resilience';
import { defaultAgentRetries } from './providers/aiSdkProvider';
import { RateLimiter, type RateLimitOptions } from './providers/rateLimit';
import { isDefinedTool } from './tools/defineTool';
import { assertHostedToolNames, isHostedTool, type HostedTool } from './tools/hosted';
import { withAskQuestion, type ToolEntries } from './tools/built-in/askQuestion';
import { toolEntries, type ToolsOption } from './tools/toolEntries';
import { ToolConcurrency, assertToolConcurrency } from './execution/toolBatch';
import { assertMaxToolResultChars } from './execution/toolResult';
import type { ToolErrorMessageFn } from './execution/toolErrors';
import type { Skill } from './skills/defineSkill';
import { assertUsable as assertSkillsUsable } from './skills/withSkills';
import type { Message, ModelSettings } from './providers/llm';
import type { PromptCachingOption } from './providers/promptCaching';
import type { ReasoningOption } from './providers/reasoning';
import {
  AgentSession,
  enqueueSessionWork,
  pausedSessionTurn,
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
import { assertMaxSubagentDepth, assertNoTaskTool, assertSubagents, registerSubagent, subagentsWithOptions, type SubagentCaller } from './subagents/withSubagents';
import type { SubagentSpec } from './execution/delegation';
import type { ApprovalDecision, ApprovalStore, ExecutionSnapshot, ResolvedApproval } from './execution/ApprovalGate';
import { InMemoryApprovalStore } from './execution/InMemoryApprovalStore';
import { resumeRequest, type ResumeRequest } from './execution/resume';
import { RUN_CONFIG_KEY, type CheckpointStore, type ForkOptions, type ForkResult } from './execution/checkpoint';
import type { AgentDriftMode } from './execution/agentFingerprint';
import { ConfigurationError, SDKError, SessionAwaitingApprovalError } from './execution/errors';
import { newId } from './utils/id';
import { assertListable, listPendingRuns, type PendingRun } from './agentPending';
import { startRecovery, type RecoverOptions, type RunRecovery } from './agentRecover';
import { createAgentApprovals, type AgentApprovals, type ApproveToolCall } from './createAgentApprovals';
import { createAgentOAuth, type AgentOAuth } from './oauth/agentOAuth';
import type { OAuthTokenStore } from './oauth/types';
import {
  APPROVAL_TTL_RULE,
  assertPermissionMode,
  isApprovalTtl,
  unknownPermissionToolMessage,
  unknownPermissionTools,
  type PermissionMode,
  type PermissionOptions,
} from './execution/permissions';
import { assertToolSearchOptions, type ToolSearchOptions } from './execution/toolSearch';
import { assertOutputSchema, type OutputSpec } from './execution/structuredOutput';
import { assertCodeModeOptions, codeModeOption, type CodeModeOptions } from './execution/codeMode';
import type { InferSchemaOutput, StandardSchemaV1 } from './utils/zodCompat';
import type { McpServerSpec } from './spec/schema';
import { agentMcp, streamAfter, streamPrepared } from './tools/mcp/agentMcp';
import { HookRegistry, type AgentHook } from './execution/hooks';
import { toMessages, type AgentInput } from './providers/content';
import { compactionHookFor, type AgentCompaction } from './context/agentCompaction';
import type { MemorySlot } from './memory/defineMemory';
import { agentMemory, type AgentMemory } from './memory/withMemory';
import { assertCheckpointId, assertRunId } from './session/checkpointId';
import { assertMaxSteps, type RunLimits } from './execution/budget';
import type { AgentGuardrails } from './execution/ioGuardrails';
import type { Principal } from './auth/types';
import type { Handoff } from './handoffs';
import { checkHandoffs, handoffRunner, registerHandoffAgent } from './handoffAgents';
import { activeAgentOf } from './execution/handoffRun';

/** What a `model` / `instructions` / `tools` function gets: the run it is resolved for. */
export interface RunConfigContext {
  /** `send()` / `stream()`'s `sessionId`, or the `agent.session()` id. */
  sessionId?: string;
  /** The run's user input, as given to `send()` / `stream()`. */
  input: AgentInput;
  /** The call's `metadata` option. */
  metadata?: Record<string, unknown>;
  /**
   * The caller the route's auth accepted (docs/auth.md), or the channel's
   * sender; `undefined` for a call that did not pass one. Verified, unlike `metadata`.
   */
  principal?: Principal;
}

/**
 * A static value, or a function of the run, resolved once when the
 * run starts (each session turn resolves again). See docs/api-overview.md.
 *
 * @example
 * ```ts
 * const model: PerRun<string> = ({ metadata }) => (metadata?.plan === 'pro' ? 'openai/gpt-4o' : 'openai/gpt-4o-mini');
 * ```
 */
export type PerRun<T> = T | ((ctx: RunConfigContext) => T | Promise<T>);

/** The `tools` option's static form; hosted tools (`webSearch()`, ...) go in it too. arrays may mix tools and records of them. */
type AgentToolsOption = ToolsOption;

/**
 * Options for createAgent() that do not depend on how the instructions and
 * model are given. Tools are keyed by the name the agent (and
 * AgentConfig.tools) will refer to them by - createAgent() registers each
 * one into a fresh ToolRegistry under that key.
 */
export interface CreateAgentBase<TOutput extends StandardSchemaV1 = StandardSchemaV1> extends PermissionOptions {
  /**
   * Optional tools: an array of `defineTool()` results (named by the tool),
   * or a record of descriptors keyed by the name the agent should call them by
   * (the shape `connectMcp().tools` has). an array may mix tools,
   * named descriptors (what `connectMcp()` loads) and records of them, so
   * `tools: [mcp.tools, weatherTool]` and `tools: [...fsTools, mcp.tools]`
   * work too. A function of the run picks them per run (see `PerRun`).
   * Hosted provider tools (`webSearch()`, `codeInterpreter()`,
   * `fileSearch()`, `hostedTool()`) go here too; the provider runs them (see
   * docs/hosted-tools.md). In the record form a hosted tool's key must be its name.
   *
   * @example
   * createAgent({ instructions: '...', provider, tools: [sendEmail] });
   */
  tools?: PerRun<AgentToolsOption>;
  /**
   * MCP servers to connect, keyed by name: stdio `{ command, args?, env? }`
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
   * Optional skills: only name + description go in the system
   * prompt; the model loads a skill's full content with the auto-registered
   * `load_skill` tool. Build them with `defineSkill()` or `loadSkills()`.
   *
   * @example
   * createAgent({ instructions: '...', provider, skills: await loadSkills('./skills') });
   */
  skills?: readonly Skill[];
  /** Optional agent name; defaults to 'agent'. */
  name?: string;
  /**
   * What this agent does, in a sentence. Required when the agent is
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
   * Sub-agents this agent can delegate to: `createAgent()` agents
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
   * Background sub-agent options: `maxConcurrent` (default 3) and
   * `awaitBackgroundOnFinish` (default `false`: tasks still running when a
   * run ends are cancelled). Override those set with `withSubagentOptions()`.
   */
  subagentOptions?: SubagentOptions;
  /**
   * Agents this agent can hand the whole conversation to: `createAgent()`
   * agents with a `name` and a `description`, or `handoff(agent, options)`.
   * Each is offered as a `transfer_to_<name>` tool; when the model calls one,
   * the run goes on as that agent, which answers the user and keeps the
   * conversation in later session turns. The array is read at every run, so a
   * target that hands back can be added after this agent is created. See
   * docs/handoffs.md.
   *
   * @example
   * ```ts
   * const triage = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'Route the user.', handoffs: [billing, techSupport] });
   * ```
   */
  handoffs?: ReadonlyArray<SimpleAgent | Handoff>;
  /** How many handoffs one run may make (default 5); a handoff call over it gets a tool error and the agent answers itself. */
  maxHandoffs?: number;
  /**
   * Tunes tool search. Tools marked `deferLoading` (`defineTool({ deferLoading })`,
   * or `mcpServers: { name: { ..., deferLoading: true } }`) are withheld from
   * the model, which finds them with the built-in `tool_search` tool, once
   * their definitions reach `thresholdPercent` (default 10%) of the context
   * window. `false` sends every tool on every call. See docs/tool-search.md.
   *
   * @example
   * ```ts
   * createAgent({ model: 'openai/gpt-4o-mini', mcpServers: { github: { url: 'https://example.com/mcp', deferLoading: true } }, toolSearch: { maxResults: 3 } });
   * ```
   */
  toolSearch?: false | ToolSearchOptions;
  /**
   * Code mode: adds a `run_code` tool. The model writes one short
   * JavaScript program that calls the agent's tools as async functions
   * (`await tools.get_weather({ city: 'Paris' })`), loops and combines their
   * results, and returns one value: many tool calls for one model round trip.
   * The script runs in a QuickJS WebAssembly isolate (optional peer
   * `quickjs-emscripten`) with time, memory, call and output limits; every
   * tool call it makes passes the same hooks, permission rules, guardrails and
   * approval check as a direct call, and a call that needs approval is refused
   * inside the script. See docs/code-mode.md.
   *
   * @example
   * ```ts
   * createAgent({ model: 'openai/gpt-4o-mini', tools: [getPrice, convert], codeMode: { exclusive: true } });
   * ```
   */
  codeMode?: boolean | CodeModeOptions;
  /**
   * How deep sub-agents may nest. Defaults to 1: this agent's sub-agents
   * cannot call sub-agents of their own (they are not offered the `task`
   * tool). The top-level agent's value applies to the whole tree.
   */
  maxSubagentDepth?: number;
  /** Optional maxSteps passed through to AgentExecutor.execute(). */
  maxSteps?: number;
  /**
   * Budgets of each run: `maxTokens`, `maxInputTokens`,
   * `maxOutputTokens`, `maxCostUsd`, `maxDurationMs`, `maxSteps`, `maxToolErrors` and
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
   * Input, output and tool guardrails of each run. A block ends the
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
   * How many tool calls from one model turn may run at once.
   * Defaults to `'unbounded'`; `1` runs them one at a time. Results always
   * reach the transcript in the model's call order. See
   * `ExecuteOptions.toolConcurrency` for the full contract.
   *
   * @example
   * ```ts
   * const agent = createAgent({ instructions: '...', provider, tools: [sendEmail], toolConcurrency: 1 });
   * ```
   */
  toolConcurrency?: ToolConcurrency;
  /**
   * The most characters of one tool result the model gets. A
   * longer result keeps its head and tail with a truncation marker. Default
   * 50_000 (about 12k tokens); `Infinity` turns the cap off. See docs/tools.md.
   *
   * @example
   * ```ts
   * const agent = createAgent({ instructions: '...', provider, tools: [dumpLogs], maxToolResultChars: 20_000 });
   * ```
   */
  maxToolResultChars?: number;
  /**
   * Rewrites the text of an exception a tool throws before it reaches the
   * model, the event stream (`tool.done`) and `postToolCall` hooks. The
   * result's `message` becomes your string; `kind` stays `'execution'`.
   * Receives the original error, so log it here. Argument-validation errors
   * and other kinds (MCP, sandbox, ...) are not rewritten. If it throws, the
   * message is a generic "The tool failed." and the run continues. Unset, the
   * error's own message is sent. See docs/tools.md.
   *
   * @example
   * ```ts
   * const agent = createAgent({ instructions: '...', provider, tools, toolErrorMessage: (error, { toolName }) => `${toolName} failed` });
   * ```
   */
  toolErrorMessage?: ToolErrorMessageFn;
  /**
   * What a resume does when this agent differs from the one that
   * paused or crashed the run (another model, tools with other names or
   * input schemas, other instructions): `'warn'` (default) emits an
   * `agent.drift` event and a `console.warn`, then continues; `'error'`
   * rejects with `LOUSHO_AGENT_DRIFT` before any model call or tool runs and
   * leaves the checkpoint and approval as they were; `'ignore'` does nothing.
   * A pending tool call whose tool no longer exists always rejects with
   * `LOUSHO_RESUME_TOOL_MISSING`. See `ExecuteOptions.onAgentDrift`.
   *
   * @example
   * ```ts
   * const agent = createAgent({ instructions: '...', provider, store, onAgentDrift: 'error' });
   * ```
   */
  onAgentDrift?: AgentDriftMode;
  /**
   * How much the model reasons before it answers: an effort, or
   * `{ effort, budgetTokens, summary, force }`. Sent only to model families
   * known to accept it; `stream()` reports it as `reasoning.*` events and
   * `result.reasoning` holds its text. A `send()` / `stream()` call's own
   * `reasoning` overrides it. See docs/reasoning.md.
   *
   * @example
   * ```ts
   * createAgent({ model: 'anthropic/claude-sonnet-4-5', reasoning: 'high' });
   * ```
   */
  reasoning?: ReasoningOption;
  /**
   * Sampling settings sent on every model call of this agent's runs:
   * `maxTokens`, `temperature`, `topP`, `frequencyPenalty`, `toolChoice`,
   * `presencePenalty`, `stop`, `seed`. A key left out is not sent, so the
   * provider's own default (or a wrapping provider's value) applies. A
   * `send()` / `stream()` call's `modelSettings` win key by key. Sub-agents
   * and handoff targets use their own. See docs/configuration.md#model-settings.
   *
   * @example
   * ```ts
   * createAgent({ model: 'openai/gpt-4o-mini', modelSettings: { maxTokens: 1024, temperature: 0.2 } });
   * ```
   */
  modelSettings?: ModelSettings;
  /**
   * Anthropic prompt caching. `'auto'` (the default) marks
   * `cache_control` breakpoints on the system prompt, the last tool
   * definition and the last user turn for Claude models (`anthropic/...`, and
   * `openrouter/anthropic/...`), so the next call reads that prefix at 10% of
   * the input price (writes cost 125%). `false` marks none. OpenAI and other
   * providers cache on their own. See docs/models-and-cost.md#prompt-caching.
   */
  promptCaching?: PromptCachingOption;
  /**
   * Called with every {@link AgentEvent} of this agent's runs -
   * `send()`, `stream()`, session turns and runs resumed after an approval -
   * synchronously, the same events in the same order as `stream()` yields.
   * With a listener, `send()` streams each model call when the provider
   * can, so a step's text arrives as several `text.delta` events, as on
   * `stream()`; listen to `text.done` for each step's whole text.
   * See docs/streaming.md#listening-without-iterating.
   *
   * @example
   * ```ts
   * createAgent({ model: 'openai/gpt-4o-mini', onEvent: (event) => console.log(event.type) });
   * ```
   */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Receives a span for every run of this agent: `send()`, `stream()`,
   * session turns, `resume()` and runs continued by `agent.approvals.resolve()`.
   * Each run is one `invoke_agent` span with `chat` and `execute_tool` spans
   * under it; sub-agents' spans join the lead's trace. `fileTraceExporter()`
   * from `@lousho/build-ai-agent/traces` writes them to `.lousho/traces` for
   * `npx lousho traces`; `createOtelTraceExporter()` sends them to
   * OpenTelemetry. See docs/observability.md.
   *
   * @example
   * ```ts
   * import { fileTraceExporter } from '@lousho/build-ai-agent/traces';
   * createAgent({ model: 'openai/gpt-4o-mini', exporter: fileTraceExporter() });
   * ```
   */
  exporter?: TraceExporter;
  /**
   * Record message and tool-argument content on the spans (the `gen_ai.*`
   * content attributes). Off by default because content is sensitive; when
   * omitted it follows `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`,
   * and is on when `LOUSHO_OBSERVE` points at a loopback collector (set `false`
   * to opt out). Only matters with an `exporter`. See `ExecuteOptions.captureContent`.
   */
  captureContent?: boolean;
  /**
   * Keep prompt and tool content off the spans (the deprecated
   * `input`/`prompt`/`args`/`result` attributes are omitted). Defaults to
   * true, so `fileTraceExporter()` files hold no message or tool content;
   * pass `false` to record them. Only matters with an `exporter`. See
   * `ExecuteOptions.redactContent`.
   *
   * @example
   * ```ts
   * import { fileTraceExporter } from '@lousho/build-ai-agent/traces';
   * createAgent({ model: 'openai/gpt-4o-mini', exporter: fileTraceExporter(), redactContent: false });
   * ```
   */
  redactContent?: boolean;
  /**
   * Opt in to appending the nearest `AGENTS.md` / `CLAUDE.md` (found by
   * walking up from `cwd`, see `loadProjectInstructions()`) to the agent's
   * instructions, under a `## Project instructions (from AGENTS.md)` heading.
   * Off by default: the SDK never reads files from disk unless asked.
   * Nothing is added when no file is found. Read once, when the agent is created.
   *
   * @example
   * ```ts
   * createAgent({ instructions: '...', provider, projectInstructions: true });
   * createAgent({ instructions: '...', provider, projectInstructions: { cwd: './packages/api', files: ['AGENTS.md'] } });
   * ```
   */
  projectInstructions?: boolean | { cwd?: string; files?: readonly string[] };
  /**
   * Where the agent keeps sessions, checkpoints and approvals, in one option:
   * a `SqliteStore`, `memoryStore()`, or any `AgentStore`.
   * `agent.session({ id })` keeps its transcript in `store.sessions` and
   * checkpoints every turn in `store.checkpoints`; `store.approvals` is the
   * default `approvalStore`; `send()` / `stream()` with a `sessionId` are
   * checkpointed in `store.checkpoints`, and `agent.resume(id)` finishes an
   * interrupted run or session turn. Per-call options win over it.
   *
   * @example
   * ```ts
   * const agent = createAgent({ model: 'openai/gpt-4o-mini', store: new SqliteStore('./.lousho/agent.db') });
   * ```
   */
  store?: AgentStore;
  /**
   * Where a run that hits a `needsApproval` tool saves its pause.
   * Defaults to `store.approvals`, else a new `InMemoryApprovalStore` per
   * agent; pass a durable store (e.g. `SqliteStore.approvals`) to resolve
   * after a restart. Decide pauses with `agent.approvals.resolve()`.
   */
  approvalStore?: ApprovalStore;
  /**
   * Decides approvals as they come up instead of pausing: `true`
   * runs the tool, `false` gives the model a rejection. Applies to `send()`,
   * sessions and `agent.approvals.resolve()`; `stream()` still ends at the pause.
   *
   * @example
   * ```ts
   * createAgent({ instructions: '...', provider, tools: [sendEmail], approve: ({ args }) => args.to === 'me@example.com' });
   * ```
   */
  approve?: ApproveToolCall;
  /**
   * TTL: how long a pause for approval (`needsApproval`, an `ask` permission
   * rule, a sign-in) stays decidable, in milliseconds. The pending approval
   * gets `expiresAt` (so does the `approval.requested` event); decided after
   * it - also through a durable `approvalStore` in another process or after a
   * restart - the call is denied: the model gets a `kind: 'denied'` tool
   * error whose reason is 'approval expired', audited to
   * `onPermissionDecision`. An `approve` callback still waiting at the
   * deadline is cut off the same way. An `ask` rule's `ttlMs` wins over this
   * default. Unset: pauses never expire.
   *
   * @example
   * ```ts
   * createAgent({ model: 'openai/gpt-4o-mini', tools: [sendEmail], approvalTtlMs: 5 * 60_000 });
   * ```
   */
  approvalTtlMs?: number;
  /**
   * Adds the built-in `ask_question` tool: the agent can ask the
   * user a question, and the run pauses (like an approval, `kind: 'question'`)
   * until `agent.approvals.answer({ id, answer })`. Off by default.
   */
  askQuestion?: boolean;
  /**
   * Retries of a failed model call, with `withRetry()`: rate
   * limits, timeouts, network errors and 5xx responses, with exponential
   * backoff. Defaults to `{ maxRetries: 2 }` for every model given as a
   * `provider/model` string (resolved with the `ai` SDK's own retries off, so
   * this is the only retry layer); `false` turns retries off. A built-in
   * provider instance or a `fromAiSdk()` provider is wrapped the same way,
   * with its own `maxRetries` (default 2) when `retry` is unset; the wrapper
   * is then the only retry layer (the `ai` SDK's own retries are off), and
   * `false` sends each call once. Any other `provider` instance is wrapped
   * only when you set `retry`. A streamed step is also retried
   * when it fails before any text or tool call (reasoning chunks don't count).
   * `stream()` reports each retry as a `provider.retry` event.
   *
   * @example
   * ```ts
   * createAgent({ model: 'openai/gpt-4o-mini', retry: { maxRetries: 4, backoff: { initialMs: 1000 } } });
   * ```
   */
  retry?: WithRetryOptions | false;
  /**
   * Client-side limits on the agent's model calls: calls queue
   * (abort-aware) to stay under `requestsPerMinute`, `tokensPerMinute`
   * (estimated, then the reported usage) and `maxConcurrent`. One budget is
   * shared by every run of the agent and by the sub-agents and handoff
   * targets it runs; pass a `createRateLimiter()` to share it across agents.
   * A call and its retries count as one. See docs/configuration.md#rate-limits.
   *
   * @example
   * ```ts
   * createAgent({ model: 'openai/gpt-4o-mini', rateLimit: { requestsPerMinute: 60, maxConcurrent: 4 } });
   * ```
   */
  rateLimit?: RateLimitOptions | RateLimiter;
  /**
   * `provider/model` strings tried in order when the primary model's call
   * still fails after its retries, each resolved like `model` and
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
   * A zod schema (zod 3 or 4, or any Standard Schema that can produce JSON Schema) for the agent's final reply: the model is asked
   * to answer with a JSON object matching it, and `send()` / `stream()`
   * resolve with it parsed and validated as `result.object`, typed
   * the schema's output type (`result.text` keeps the raw JSON). An invalid
   * reply gets one repair step; still invalid, the run ends with
   * `finishReason: 'output-invalid'` and `outputError`. See
   * docs/structured-output.md and `ExecuteOptions.output`.
   *
   * As `{ schema, promptSchema: false }` the schema goes only on
   * `responseFormat`, not into the system prompt too - for providers that
   * enforce it, that saves sending the schema twice. `responseFormat` is
   * sent only on calls that offer no tools unless
   * `{ schema, responseFormat: 'always' }` (the default with
   * `promptSchema: false`); see `OutputSpec`.
   *
   * @example
   * ```ts
   * const agent = createAgent({ model: 'openai/gpt-4o-mini', output: z.object({ city: z.string(), tempC: z.number() }) });
   * const { object } = await agent.send('Weather in Paris?');
   * ```
   */
  output?: TOutput | OutputSpec<TOutput>;
  /**
   * Hooks run around every model call and tool call, in the order
   * given, before the hook `compaction` installs. See `AgentHook` and
   * docs/api-overview.md. They apply to this agent's runs and to its sub-agents'.
   *
   * @example
   * ```ts
   * createAgent({ instructions: '...', provider, hooks: [{ name: 'audit', preToolCall: (ctx) => console.log(ctx.toolName) }] });
   * ```
   */
  hooks?: readonly AgentHook[];
  /**
   * Keeps long runs under the model's context window: `true`
   * installs `createCompactionHook()` with its defaults (prune old tool
   * results above 90% of the window); an object sets `strategy`,
   * `thresholdPercent`, `contextWindow`, `protectedTokens`,
   * `reserveOutputTokens` and `onCompaction`, and `summarizer` (a `'provider/model'` string or an `LLMProvider`) selects
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
   * Long-term memory slots, from `defineMemory()`. On the first
   * model call of each run, a slot recalls its newest items into the system
   * prompt (a `<memory name="...">` block), and the model gets
   * `remember_<name>` / `recall_<name>` tools. `scope: 'session'` keys memory
   * by the session id (`agent.session()`'s id, or `send()`'s `sessionId`).
   * See docs/memory.md.
   *
   * @example
   * ```ts
   * const notes = defineMemory({ name: 'notes', scope: 'global', provider: fileMemory({ dir: './.lousho/memory' }) });
   * createAgent({ model: 'openai/gpt-4o-mini', memory: [notes] });
   * ```
   */
  memory?: readonly MemorySlot[];
}

/**
 * A prompt-registry reference as a string type: `'name@3'` or `'name@latest'`.
 * The type is intentionally wider than the runtime parser (see
 * `parsePromptRef`: the name may not contain whitespace, `/` or `@`, and the
 * version is an integer) - it exists so the {@link CreateAgentInstructions}
 * union can tell the ref apart from the deprecated `prompt` alias.
 */
export type PromptRefString = `${string}@${number}` | `${string}@latest`;

/**
 * The system prompt. `instructions` is the name to use; `prompt` is a
 * deprecated alias kept for older code. Give at most one - both is an error
 * - UNLESS `prompt` is a `'name@version'` prompt-registry reference: that is
 * the prompts-context-hub opt-in (spec 0001), fetched from the observe
 * daemon (`LOUSHO_OBSERVE`, or set `LOUSHO_PROMPT` to opt in without config)
 * at agent build. The fetched text then replaces `instructions` (the opt-in
 * means the registry owns the text) and `instructions` stays the embedded
 * fallback for when the daemon cannot be reached. Omit both for a minimal
 * default ("You are a helpful assistant."). Either may be a function of the
 * run (see `PerRun`), though a function `prompt` can only be the alias.
 */
export type CreateAgentInstructions =
  | {
      /** System prompt for the agent (preferred name); also the embedded fallback of a `prompt` registry ref. */
      instructions?: PerRun<string>;
      /** A `'name@version'` registry ref (`version` an integer or `latest`, resolved daemon side). */
      prompt?: PromptRefString;
    }
  | {
      instructions?: undefined;
      /** @deprecated Use `instructions`; a non-`'name@version'` `prompt` is a legacy alias for it. */
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
 * 3. Neither - resolved from the environment: `LOUSHO_MODEL` (a
 *    `provider/model` string) if set, otherwise the first provider whose key
 *    is set, checked in the order OPENAI_API_KEY, ANTHROPIC_API_KEY,
 *    OPENROUTER_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OLLAMA_BASE_URL. Throws, listing the fixes, when
 *    none is set.
 *
 * `model` may be a function of the run (see `PerRun`) returning
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
export type CreateAgentConfig<TOutput extends StandardSchemaV1 = StandardSchemaV1> = CreateAgentBase<TOutput> &
  CreateAgentInstructions &
  CreateAgentModelSource;

/** Per-call options for `SimpleAgent.send()`. */
export interface SendOptions {
  /**
   * Cancels this run. The returned promise then resolves - it
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
   * Makes this a durable run: it is checkpointed under this id in
   * the agent's `store.checkpoints` after every model response and tool
   * result, and `agent.resume(sessionId)` finishes it after a crash. Calling
   * again with the same id continues the conversation. Needs
   * `createAgent({ store })` with `checkpoints`. See `ExecuteOptions.sessionId`.
   * This is a run id: 1-200 characters of `A-Za-z0-9_.-`, not starting or
   * ending with `.`, and not ending in `.turn-<n>`, `.paused` or `.fire`. A
   * session id (`agent.session({ id })`) is stricter: 1-128 characters, no `.`.
   *
   * @example
   * ```ts
   * const result = await agent.send('Run the import.', { sessionId: 'job-1' });
   * ```
   */
  sessionId?: string;
  /**
   * Passed to memory scope functions, e.g. `{ userId }` for
   * `scope: ({ metadata }) => \`user:${metadata?.userId}\``, and to
   * `model` / `instructions` / `tools` functions.
   */
  metadata?: Record<string, unknown>;
  /**
   * Who is calling: what a route's auth list accepted. Passed to memory
   * scope functions and to `model` / `instructions` / `tools` functions; a
   * resumed dynamic run gets the principal it started with. See docs/auth.md.
   */
  principal?: Principal;
  /**
   * Receives this run's events (the ones `stream()` yields), including a
   * sub-agent's, tagged with `subagent`. It runs next to the agent's own
   * `onEvent`. Trajectory evals use it to see sub-agent tool calls.
   *
   * @example
   * ```ts
   * await agent.send('hi', { onEvent: (event) => console.log(event.type) });
   * ```
   */
  onEvent?: (event: AgentEvent) => void;
  /** This run's reasoning, instead of the agent's `reasoning`. */
  reasoning?: ReasoningOption;
  /**
   * This run's sampling settings, merged over the agent's
   * `modelSettings` (a key set here wins; the others stay the agent's).
   *
   * @example
   * ```ts
   * await agent.send('Summarize the log.', { modelSettings: { maxTokens: 256 } });
   * ```
   */
  modelSettings?: ModelSettings;
  /**
   * This run's step limit, instead of the agent's `maxSteps`
   * (a whole number >= 1). A run continued by `agent.approvals.resolve()` or
   * `agent.resume()` uses the agent's again.
   *
   * @example
   * ```ts
   * await agent.send('Just answer, no research.', { maxSteps: 1 });
   * ```
   */
  maxSteps?: number;
  /**
   * Text appended to the agent's instructions for this run
   * (the agent's own instructions always stay). Sent with each model call of
   * the run, a handoff target's too, and never stored in the transcript: a
   * later call with the same `sessionId` does not keep it, and a run
   * continued by `agent.approvals.resolve()` or `agent.resume()` runs without it.
   *
   * @example
   * ```ts
   * await agent.send('Summarize the ticket.', { instructions: 'Answer in French.' });
   * ```
   */
  instructions?: string;
  /**
   * This run's permission mode, instead of the agent's `permissionMode`.
   * A run continued by `agent.approvals.resolve()` uses the agent's again.
   * See docs/permission-modes.md.
   */
  permissionMode?: PermissionMode;
  /**
   * TTL: this run's approval deadline (the agent's `approvalTtlMs` otherwise):
   * pauses this run makes expire after it. A run continued by
   * `agent.approvals.resolve()` uses the agent's again.
   */
  approvalTtlMs?: number;
  /**
   * Parents this run's `invoke_agent` span to a span of yours, e.g. the
   * `span.id` a `withSpan()` callback gets, so several `send()` calls land in
   * one trace. See `ExecuteOptions.parentSpanId` and docs/observability.md.
   *
   * @example
   * ```ts
   * await withSpan(exporter, 'pipeline', {}, (span) => agent.send('hi', { parentSpanId: span.id }));
   * ```
   */
  parentSpanId?: string;
  /**
   * For `stream()` only: when the run fails, the `for await` loop
   * rethrows the error (the one `run.result` rejects with and `send()` would
   * throw) after it has yielded the `error` and `run.done { finishReason: 'error' }`
   * events. `false` ends the loop normally and leaves the error to the events
   * and `run.result`. Default `true`. See docs/streaming.md.
   */
  throwOnError?: boolean;
}

/** How a run is checkpointed, plus (TTL) a `send()` / `stream()` call's own `reasoning`, `modelSettings`, `permissionMode`, `approvalTtlMs`, `parentSpanId`. */
type RunTurn = SessionTurnOptions &
  Pick<ExecuteOptions, 'reasoning' | 'modelSettings' | 'permissionMode' | 'approvalTtlMs' | 'parentSpanId' | 'maxSteps' | 'appendInstructions'>;

/** `TObject`: the type of `result.object` - `z.output` of the `output` schema. */
export interface SimpleAgent<TObject = unknown> {
  /**
   * Send a single user message and get back the full execution result text.
   * `message` is a string, content parts (one user message with an image or
   * file) or a `Message[]` passed through as it is.
   */
  send: (message: AgentInput, options?: SendOptions) => Promise<ExecutionResult<TObject>>;
  /**
   * Send a single user message and stream the run as typed events:
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
   * Start a multi-turn conversation: every `send()` sees the earlier
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
  session: (options?: SessionOptions) => AgentSession<TObject>;
  /**
   * Finishes what was interrupted under `sessionId`, from the
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
   * Forks the `sessionId` run at `fromStep`: `AgentExecutor.fork()`
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
   * The runs left unfinished in the agent's `store.checkpoints`,
   * across all sessions and processes: interrupted turns and runs
   * (`status: 'in-progress'`, finish them with `agent.resume(sessionId)`) and
   * ones paused on an approval (`'awaiting-approval'`, decide `approvalId`
   * with `agent.approvals.resolve()`). Call it at startup to recover after a
   * crash (docs/durable-execution.md, "Recovering after a crash"). A run still
   * running in some process is listed as `'in-progress'` too. Throws
   * `LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE` without a checkpoint store, and
   * `LOUSHO_CONFIG_INVALID` when the store has no `list()`.
   *
   * @example
   * ```ts
   * for (const run of await agent.pending()) {
   *   if (run.status === 'in-progress') await agent.resume(run.sessionId);
   * }
   * ```
   */
  pending: () => Promise<PendingRun[]>;
  /**
   * Starts a loop that finishes interrupted runs on its own: every
   * `intervalMs` (default 30 s) it lists `agent.pending()` and calls
   * `agent.resume()` on each `'in-progress'` run. Runs paused on an approval or
   * a question are left alone, and so are runs whose `lastError` is not
   * retryable. A run still running elsewhere, or whose crashed process's run
   * lease has not expired yet, is skipped (its lease turns the resume away
   * before anything runs) and retried on a later sweep, so no run is resumed
   * twice at once and completed steps never run again
   * (docs/durable-execution.md, "Recovering automatically"). Stop it with
   * `signal` or `stop()`; `done` resolves once it stopped. Throws like
   * `pending()` without a listable checkpoint store.
   *
   * @example
   * ```ts
   * const recovery = agent.recover({ onError: (error, run) => console.error(run?.sessionId, error) });
   * process.on('SIGTERM', () => void recovery.stop());
   * ```
   */
  recover: (options?: RecoverOptions<ExecutionResult<TObject>>) => RunRecovery;
  /**
   * Tool calls this agent is paused on, waiting for approval. A
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
   * OAuth sign-ins for tools that call `ctx.getToken()` (docs/oauth.md):
   * `complete()` finishes a sign-in at the callback, `signInUrl()` signs the
   * app itself in to an app-owned provider. Tokens live in `store.tokens`.
   */
  oauth: AgentOAuth;
  /**
   * Connects the `mcpServers` and registers their tools; `send()`
   * and `stream()` await it. Resolves at once without `mcpServers`.
   */
  ready: () => Promise<void>;
  /** Disconnects the `mcpServers` (a later tool call reconnects); a no-op without them. */
  close: () => Promise<void>;
}

/** The `CreateAgentConfig` each `createAgent()` result was built with. */
const builtConfigs = new WeakMap<SimpleAgent, CreateAgentConfig>();

/**
 * @internal The config `agent` was created with, or `undefined` when it did not
 * come from `createAgent()`. `lousho dev` / `lousho chat` use it to rebuild a
 * module's built-agent export with CLI overrides (`--traces`' exporter): an
 * already-built agent cannot take a new exporter after the fact.
 */
export function createAgentConfigOf(agent: SimpleAgent): CreateAgentConfig | undefined {
  return builtConfigs.get(agent);
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
export function createAgent<TOutput extends StandardSchemaV1 = StandardSchemaV1>(
  config: CreateAgentConfig<TOutput> = {}
): SimpleAgent<InferSchemaOutput<TOutput>> {
  assertKnownCreateAgentKeys(config);
  assertToolConcurrency(config.toolConcurrency, 'createAgent');
  assertMaxSteps(config.maxSteps, 'createAgent');
  assertModelSettings(config.modelSettings, 'createAgent');
  assertMaxToolResultChars(config.maxToolResultChars, 'createAgent');
  assertMaxSubagentDepth(config.maxSubagentDepth, 'createAgent');
  assertSubagents(config.subagents, 'createAgent');
  assertApprovalTtlMs(config.approvalTtlMs);
  if (typeof config.permissionMode === 'string') assertPermissionMode(config.permissionMode, 'createAgent');
  assertMaxHandoffs(config.maxHandoffs);
  assertToolSearchOptions(config.toolSearch, 'createAgent');
  assertOutputSchema(config.output);
  assertCodeModeOptions(config.codeMode, 'createAgent');
  const agentName = config.name || 'agent';
  const handoffTools = checkHandoffs(config.handoffs, { name: agentName }, 'createAgent').map((checked) => checked.toolName);
  const hasMcp = Object.keys(config.mcpServers ?? {}).length > 0;
  const memory = agentMemory(config.memory);
  const mcpTools: Record<string, ToolDescriptor> = {};
  const toolsFor = (tools: AgentToolsOption | undefined): RunTools => {
    // Hosted tools are sent to the provider, never registered.
    const { local, hosted } = splitHostedTools(tools);
    const runTools = { ...registerTools(withAskQuestion(local, config.askQuestion), hasMcp), hostedTools: hosted };
    memory?.addTools(runTools.toolsConfig);
    addMcpTools(runTools, mcpTools);
    assertHostedToolNames(hosted, Object.keys(runTools.toolsConfig));
    return runTools;
  };

  const runOptions = {
    // Also used by resumed runs and when this agent is a sub-agent.
    permissions: config.permissions,
    onPermissionDecision: config.onPermissionDecision,
    // The agent's mode; a session's turn or a send() call may override it.
    permissionMode: config.permissionMode,
    skills: config.skills,
    // `task` conversations are kept in the agent's session store, to be resumed by taskId.
    subagents: subagentsWithOptions(config.subagents, subagentOptionsOf(config)),
    maxSubagentDepth: config.maxSubagentDepth,
    maxSteps: config.maxSteps,
    limits: config.limits,
    guardrails: config.guardrails,
    toolConcurrency: config.toolConcurrency,
    // Also for resumed runs.
    maxToolResultChars: config.maxToolResultChars,
    toolErrorMessage: config.toolErrorMessage,
    // TTL: the default pause deadline; an `ask` rule's `ttlMs` overrides it.
    approvalTtlMs: config.approvalTtlMs,
    onAgentDrift: config.onAgentDrift,
    reasoning: config.reasoning,
    ...(config.promptCaching !== undefined && { promptCaching: config.promptCaching }),
    // Also for resumed runs and when this agent is a sub-agent.
    modelSettings: config.modelSettings,
    // One budget for the agent's runs, its sub-agents and handoff targets.
    ...(config.rateLimit && { rateLimiter: config.rateLimit instanceof RateLimiter ? config.rateLimit : new RateLimiter(config.rateLimit) }),
    toolSearch: config.toolSearch,
    // Also for resumed runs and when this agent is a sub-agent.
    ...codeModeOption(config.codeMode),
  };
  // The prompt-registry opt-in (config.prompt as 'name@version', or
  // LOUSHO_PROMPT) starts its daemon fetch HERE - at agent build, per the
  // spec - and the resolved instructions below await it per run.
  const resolvedInstructions = agentInstructions(config);
  const specs = agentSpecs(config, toolsFor, runOptions, resolvedInstructions);
  const staticSpec = specs.static;
  if (staticSpec && config.subagents) assertNoTaskTool(staticSpec.agent, staticSpec.toolRegistry);
  // Like `task`: a tool named `load_skill` clashes with `skills` here, not at the first send().
  if (staticSpec && config.skills?.length) assertSkillsUsable(config.skills, staticSpec.agent, staticSpec.toolRegistry);
  // A handoff tool may not share a tool's name (a per-run `tools` function is checked when the run starts).
  assertNoHandoffToolClash(handoffTools, specs.staticTools);
  warnUnknownPermissionTools(config, handoffTools, specs.staticTools);
  // MCP tools join the registry and the agent's tools once connected.
  const mcp = agentMcp(
    config.mcpServers,
    (tools) => {
      // After a server's tools/list_changed, drop the tools it no longer offers (or replaced).
      for (const [name, descriptor] of Object.entries(mcpTools)) {
        if (tools[name] === descriptor) continue;
        delete mcpTools[name];
        if (specs.staticTools) removeMcpTool(specs.staticTools, name, descriptor);
      }
      Object.assign(mcpTools, tools);
      if (specs.staticTools) addMcpTools(specs.staticTools, tools);
    },
    // Servers with `oauth` keep their tokens with the tools' ones.
    config.store?.tokens
  );
  const hooks = agentHooks(config);
  // Every run of this agent (send, stream, sessions, resume, approvals) is traced.
  // `LOUSHO_OBSERVE` fans the config's exporter out with the collector reporter;
  // unset means the env half is a no-op (see src/observe/reporter.ts).
  const exporter = withObserveExporter(
    config.exporter,
    agentName,
    resolvedInstructions.promptUse !== undefined ? { promptUse: resolvedInstructions.promptUse } : {}
  );
  // Content defaults on when the env collector is this machine's own (the trace
  // view cannot explain a failure without it); an explicit setting always wins.
  const captureContent = defaultCaptureContent(config.captureContent);
  const tracing: Pick<ExecuteOptions, 'exporter' | 'captureContent' | 'redactContent'> = {
    ...(exporter && { exporter }),
    ...(captureContent !== undefined && { captureContent }),
    ...(config.redactContent !== undefined && { redactContent: config.redactContent }),
  };
  const checkpoints = config.store?.checkpoints;
  /** The handoffs of this agent's runs, and the agent a run continues with after one. */
  const handoffs = handoffRunner({
    agent: () => simpleAgent,
    name: agentName,
    runOptions,
    // Handed back to, the agent gets its memory tools again (bound to the run's scope).
    spec: async (ctx, pinned, viaHandoff) => {
      await mcp.ready();
      const spec = staticSpec ?? (await specs.resolve(ctx, pinned as PinnedRunConfig | undefined));
      if (!viaHandoff || !memory) return spec;
      const scope = { sessionId: ctx.sessionId, metadata: ctx.metadata, principal: ctx.principal };
      return { ...spec, toolRegistry: memory.forRun(scope, spec.toolRegistry, undefined).toolRegistry };
    },
    // The agents it hands to keep its memory: the same slots, bound to the run's scope keys.
    ...(memory && { target: (spec, ctx) => memory.forTarget({ sessionId: ctx.sessionId, metadata: ctx.metadata, principal: ctx.principal }, spec) }),
  });
  // Tools' OAuth tokens (`ctx.getToken()`) and pending sign-ins.
  const tokens = config.store?.tokens;
  const resumeRequestFor = resumeRequester({
    specs,
    handoffs,
    runOptions,
    config,
    hooks,
    checkpoints,
    tokens,
    tracing,
    memory,
  });
  const approvals = createAgentApprovals({
    store: approvalStoreOf(config),
    approve: config.approve,
    resume: async (...args) => resumeRequest(await resumeRequestFor(...args)),
    // The streamed run's own signal and event sink are wired into the request.
    streamResume: (approvalStore, decision, signal, checkpointStore, inputQueue, permissionMode, approver, onAgentEvent) =>
      streamResumed(async (wire) => {
        const request = await resumeRequestFor(approvalStore, decision, undefined, checkpointStore, permissionMode, approver, onAgentEvent);
        return resumeRequest({ ...request, executeOptions: wire(request.executeOptions ?? {}) });
      }, signal, inputQueue),
    // A pause resolved in a fresh process re-binds to the session its turn
    // belongs to: `checkpoints` tells a session turn apart
    // from a send({ sessionId }) run; `openSession` re-opens it.
    checkpoints,
    openSession: (id) => session({ id }),
  });
  /** A run under `sessionId`, checkpointed in the agent's store. */
  const durable = (sessionId: string | undefined): Partial<SessionTurnCheckpoint> => {
    if (sessionId === undefined) return {};
    if (!checkpoints) {
      throw new ConfigurationError(
        `createAgent: a run with sessionId '${sessionId}' needs a checkpoint store - ` +
          'pass createAgent({ store }) with `checkpoints` (e.g. a SqliteStore or memoryStore()).',
        'store',
        'LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE'
      );
    }
    return { sessionId, checkpointStore: checkpoints };
  };
  const callTurn = ({ sessionId, reasoning, modelSettings, maxSteps, instructions, permissionMode, approvalTtlMs, parentSpanId, onEvent }: SendOptions): RunTurn => {
    // One id rule for every store, and never a session's own checkpoint keys (`<id>.turn-<n>`, `<id>.paused`).
    if (sessionId !== undefined) assertRunId(sessionId, 'send: sessionId');
    if (permissionMode !== undefined) assertPermissionMode(permissionMode, 'send');
    assertModelSettings(modelSettings, 'send');
    assertMaxSteps(maxSteps, 'send');
    assertApprovalTtlMs(approvalTtlMs, 'send');
    if (instructions !== undefined && typeof instructions !== 'string') {
      throw new ConfigurationError(`send: 'instructions' must be a string, got ${instructions === null ? 'null' : typeof instructions}.`, 'instructions');
    }
    return {
      ...durable(sessionId),
      ...(reasoning !== undefined && { reasoning }),
      ...(modelSettings !== undefined && { modelSettings }),
      ...(maxSteps !== undefined && { maxSteps }),
      ...(instructions && { appendInstructions: instructions }),
      ...(permissionMode !== undefined && { permissionMode }),
      ...(approvalTtlMs !== undefined && { approvalTtlMs }),
      ...(parentSpanId !== undefined && { parentSpanId }),
      ...(onEvent !== undefined && { onAgentEvent: onEvent }),
    };
  };
  /** Memory tools and recall bound to the run's scope keys; a handoff target has the tools already, so it gets the recall only. */
  const runMemory = (spec: SubagentSpec, ctx: RunConfigContext, lead: boolean): Partial<ExecuteOptions> => {
    if (!memory) return {};
    const run = memory.forRun({ sessionId: ctx.sessionId, metadata: ctx.metadata, principal: ctx.principal }, spec.toolRegistry, hooks);
    return lead ? run : { hooks: run.hooks };
  };
  /** `lead`: false when the run starts as a handoff target, whose spec already has this agent's memory tools (it still recalls). */
  const executeOptions = (
    spec: SubagentSpec,
    input: Message[],
    ctx: RunConfigContext,
    signal?: AbortSignal,
    turn?: RunTurn,
    lead = true
  ): ExecuteOptions => {
    // A session's turn carries its on() forwarder; it joins the agent's listener instead of replacing it.
    const { onAgentEvent: turnListener, ...turnRest } = turn ?? {};
    return {
      ...spec,
      output: config.output,
      hooks,
      approvalStore: approvals.store,
      input,
      signal,
      onAgentEvent: mergedAgentEvent(config.onEvent, turnListener),
      ...tracing,
      ...(tokens && { tokens }),
      // A session's turn runs under its id (tools see it), unless the turn is checkpointed under its own.
      ...(ctx.sessionId !== undefined && { sessionId: ctx.sessionId }),
      // Tools, approval policies, permission rules and sub-agents act for this caller.
      ...(ctx.principal && { principal: ctx.principal }),
      // The call's metadata reaches every hook context as `ctx.metadata`.
      ...(ctx.metadata !== undefined && { metadata: ctx.metadata }),
      ...turnRest,
      // A turn checkpointed under `<id>.turn-<n>` still hands its tools, approval policies and rules the session's id.
      ...(ctx.sessionId !== undefined && turnRest.sessionId !== undefined && turnRest.sessionId !== ctx.sessionId && { contextSessionId: ctx.sessionId }),
      // The call's settings win key by key over the agent's.
      ...(turnRest.modelSettings && { modelSettings: mergeModelSettings(spec.modelSettings, turnRest.modelSettings) }),
      // Memory tools and recall bound to this run's scope keys.
      ...runMemory(spec, ctx, lead),
    };
  };
  /**
   * The run's options when this agent has handoffs: the agent the transcript (a session's, when `inSession`, or the
   * checkpointed run's) last handed off to runs, with its handoffs; else this agent.
   */
  const prepareHandoffs = async (input: Message[], ctx: RunConfigContext, signal?: AbortSignal, turn?: RunTurn, inSession = false) => {
    const checkpoint = turn?.sessionId && turn.checkpointStore ? await turn.checkpointStore.load(turn.sessionId) : null;
    const pinned = checkpoint && checkpoint.status !== 'finished' ? (checkpoint.runConfig as PinnedRunConfig | undefined) : undefined;
    const active = activeAgentOf(checkpoint ? checkpoint.messages : inSession ? input : []);
    const runCtx = pinned?.ctx ?? ctx;
    const resolved = await handoffs.run(active, runCtx, pinned);
    const options = { ...executeOptions(resolved.spec, input, runCtx, signal, turn), handoffs: resolved.handoffs, maxHandoffs: config.maxHandoffs };
    return pinned ? { ...options, principal: ctx.principal } : options;
  };
  /**
   * The run's options once MCP servers are connected, with its spec resolved for `ctx`. A dynamic run
   * restarted from its checkpoint resolves with the `ctx` and model it began with.
   */
  const prepare = async (input: Message[], callCtx: RunConfigContext, signal?: AbortSignal, turn?: RunTurn, inSession = false) => {
    // A resumed run binds its memory to the metadata and principal it was saved with when the call gives none.
    const ctx = memory ? await savedRunContext(callCtx, turn) : callCtx;
    await mcp.ready();
    if (handoffs.has()) return prepareHandoffs(input, ctx, signal, turn, inSession);
    if (staticSpec) return executeOptions(staticSpec, input, ctx, signal, turn);
    const pinned = await checkpointedRunConfig(turn);
    const options = executeOptions(await specs.resolve(pinned?.ctx ?? ctx, pinned), input, pinned?.ctx ?? ctx, signal, turn);
    // The call's own principal, so the executor refuses another caller's; without one, the run keeps its saved principal.
    return pinned ? { ...options, principal: ctx.principal } : options;
  };
  const run = async (input: Message[], ctx: RunConfigContext, signal?: AbortSignal, turn?: RunTurn, inSession = false) =>
    AgentExecutor.execute(await prepare(input, ctx, signal, turn, inSession));
  const stream = (input: Message[], ctx: RunConfigContext, signal?: AbortSignal, turn?: RunTurn, inSession = false): AgentRun => {
    if (!staticSpec || handoffs.has() || (memory && turn?.sessionId)) return streamPrepared(() => prepare(input, ctx, signal, turn, inSession), signal, turn?.inputQueue);
    const options = executeOptions(staticSpec, input, ctx, signal, turn);
    return hasMcp ? streamAfter(mcp.ready, options) : AgentExecutor.stream(options);
  };
  // A checkpointed session's turn runs under its own sessionId + checkpointStore.
  const session = agentSession<Typed>(config, approvals, run, stream);

  // `object` was validated with `config.output`, so it has its output type.
  type Typed = InferSchemaOutput<TOutput>;
  /**
   * Runs with one `sessionId` continue its checkpoint one after another (per checkpoint store, in this
   * process), like a session's turns, so a concurrent call never continues the same 'finished' checkpoint and drops a turn.
   */
  const serially = <T>(turn: RunTurn, task: () => Promise<T>): Promise<T> =>
    turn.sessionId !== undefined && turn.checkpointStore ? enqueueSessionWork(turn.checkpointStore, turn.sessionId, task) : task();
  /** A session's turn that waits on an approval locks its id - a `send(msg, { sessionId })` run must not run beside it. */
  const assertNotPaused = async (sessionId: string | undefined): Promise<void> => {
    const paused = sessionId !== undefined && checkpoints ? await pausedSessionTurn(checkpoints, sessionId) : null;
    if (paused) throw new SessionAwaitingApprovalError(paused.sessionId, paused.approvalId, paused.approvalKind);
  };
  const simpleAgent: SimpleAgent<Typed> = {
    send(message: AgentInput, options: SendOptions = {}): Promise<ExecutionResult<Typed>> {
      const { sessionId, metadata, principal } = options;
      let turn: RunTurn;
      try {
        turn = callTurn(options);
      } catch (error) {
        return Promise.reject(error);
      }
      return serially(turn, async () => {
        await assertNotPaused(sessionId);
        const result = await run(toMessages(message), { sessionId, input: message, metadata, principal }, options.signal, turn);
        // An `approve` callback's decisions continue the run under this call's mode.
        return approvals.settle(result, options.signal, undefined, turn.permissionMode) as Promise<ExecutionResult<Typed>>;
      });
    },
    stream(message: AgentInput, options: SendOptions = {}): AgentRun<Typed> {
      const { sessionId, metadata, principal } = options;
      const turn = callTurn(options);
      const ctx = { sessionId, input: message, metadata, principal };
      const run =
        sessionId === undefined
          ? stream(toMessages(message), ctx, options.signal, turn)
          : streamPrepared(
              async () => {
                await assertNotPaused(sessionId);
                return prepare(toMessages(message), ctx, options.signal, turn);
              },
              options.signal,
              turn.inputQueue,
              (task) => serially(turn, task)
            );
      return (options.throwOnError === false ? run : throwingRun(run)) as AgentRun<Typed>;
    },
    session,
    async resume(sessionId: string, { signal } = {}): Promise<ExecutionResult<Typed> | null> {
      assertCheckpointId(sessionId, 'resume: sessionId');
      const checkpoint = await checkpoints?.load(sessionId);
      // No run under this id: it names a session, whose turns are checkpointed under `<id>.turn-<n>`.
      if (!checkpoint) return session({ id: sessionId }).resume({ signal }) as Promise<ExecutionResult<Typed> | null>;
      if (checkpoint.status === 'finished') return null;
      return approvals.settle(await run([], { sessionId, input: [] }, signal, durable(sessionId)), signal) as Promise<ExecutionResult<Typed>>;
    },
    // durable() throws LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE without `store.checkpoints`.
    fork: async (sessionId, options) => {
      assertCheckpointId(sessionId, 'fork: sessionId');
      // A session's paused-turn pointer holds no transcript: fork the turn it points to (`<id>.turn-<n>`).
      if (sessionId.endsWith('.paused')) {
        throw new ConfigurationError(`fork: '${sessionId}' is a session's paused-turn pointer, not a run; fork '<id>.turn-<n>' instead.`, 'sessionId', 'LOUSHO_SESSION_ID_INVALID');
      }
      if (options.newSessionId !== undefined) assertRunId(options.newSessionId, 'fork: newSessionId');
      return AgentExecutor.fork({ ...options, ...(durable(sessionId) as SessionTurnCheckpoint) });
    },
    pending: () => listPendingRuns(checkpoints),
    recover(options) {
      assertListable(checkpoints, 'agent.recover()');
      return startRecovery({ pending: () => listPendingRuns(checkpoints), resume: (id, { signal }) => simpleAgent.resume(id, { signal }) }, options);
    },
    approvals: approvals.approvals,
    oauth: createAgentOAuth(tokens, approvals.store, mcp.oauth),
    ready: mcp.ready,
    close: mcp.close,
  };
  registerSubagent(simpleAgent, { spec: subagentRunSpec(staticSpec, (ctx) => specs.resolve(ctx), config.output, memory), description: config.description });
  // As a handoff target, the agent runs with its own config (its `output` is not used: the run's lead types the result).
  registerHandoffAgent(simpleAgent, {
    name: config.name,
    description: config.description,
    handoffs: () => config.handoffs,
    resolve: async (ctx, pinned) => {
      await mcp.ready();
      return staticSpec ?? specs.resolve(ctx, pinned as PinnedRunConfig | undefined);
    },
    // These are read by send()/stream()/session() at run start - a run
    // hands them across a handoff, so a target's are never consulted.
    runLevelOptions: runLevelOptionNames(config),
  });
  // Remembered so the CLI can rebuild the agent with its overrides
  // (`--traces`' exporter) when a module exports the built agent itself.
  builtConfigs.set(simpleAgent, config);
  return simpleAgent;
}

/**
 * How the agent runs as a sub-agent. A dynamic agent resolves its config with the task prompt as `input`, and
 * the lead run's sessionId, metadata and principal. it answers with its own `output`
 * object, never the lead's schema. It gets its own memory (recall and tools), bound to the scope keys of
 * the lead run's session, metadata and principal.
 */
function subagentRunSpec(
  staticSpec: SubagentSpec | undefined,
  resolve: (ctx: RunConfigContext) => Promise<SubagentSpec>,
  output: CreateAgentConfig['output'],
  memory: AgentMemory | undefined
): SubagentSpec | ((prompt: string, caller: SubagentCaller) => Promise<SubagentSpec>) {
  if (staticSpec && !memory) return { ...staticSpec, output };
  return async (prompt, caller) => {
    const spec = { ...(staticSpec ?? (await resolve({ ...caller, input: prompt }))), output };
    if (!memory) return spec;
    return { ...spec, ...memory.forRun({ sessionId: caller.sessionId, metadata: caller.metadata, principal: caller.principal }, spec.toolRegistry, undefined) };
  };
}

/** The entry agent's run-level options: names a handoff target can never own. */
function runLevelOptionNames(config: CreateAgentConfig): string[] {
  return (['approve', 'approvalStore', 'permissionMode', 'approvalTtlMs', 'store', 'memory'] as const).filter((key) => config[key] !== undefined);
}

/** The approval store a run writes to: the explicit one, else the store bundle's, else in-memory. */
function approvalStoreOf(config: CreateAgentConfig): ApprovalStore {
  return config.approvalStore ?? config.store?.approvals ?? new InMemoryApprovalStore();
}

/** `task` options plus the agent's session store, when it has one. */
function subagentOptionsOf(config: CreateAgentConfig) {
  const sessions = config.store?.sessions;
  return sessions ? { sessions, ...config.subagentOptions } : config.subagentOptions;
}

/**
 * A `permissions` rule that names a tool the agent does not have (a typo such as
 * `write_flie`) never matches, so a `deny` is silently off: warn at creation.
 * Tools that arrive later (MCP, tool search, sub-agents, per-run `tools`) make
 * the check report only probable typos.
 */
function warnUnknownPermissionTools(config: CreateAgentConfig, handoffTools: string[], staticTools: RunTools | undefined): void {
  if (!config.permissions?.length) return;
  const lenient = !staticTools || Object.keys(config.mcpServers ?? {}).length > 0 || !!config.toolSearch || !!config.subagents || !!config.codeMode;
  const registered = [...Object.keys(staticTools?.toolsConfig ?? {}), ...handoffTools, 'task', 'load_skill'];
  for (const issue of unknownPermissionTools(config.permissions, registered, { lenient })) {
    console.warn(`[lousho] createAgent: ${unknownPermissionToolMessage(issue)}`);
  }
}

/** A handoff tool may not share a tool's name (a per-run `tools` function is checked when the run starts). */
function assertNoHandoffToolClash(handoffTools: string[], staticTools: RunTools | undefined): void {
  const clash = handoffTools.find((name) => staticTools?.toolsConfig[name]);
  if (clash) {
    throw new ConfigurationError(`createAgent: the handoff tool '${clash}' has the name of one of the agent's tools; set another toolName with handoff(target, { toolName }).`, 'handoffs');
  }
}

/** TTL: `approvalTtlMs` must be a positive number of milliseconds, at most 100 years (a larger one is a typo). */
function assertApprovalTtlMs(value: unknown, where = 'createAgent'): void {
  if (value === undefined || isApprovalTtl(value)) return;
  throw new ConfigurationError(`${where}: 'approvalTtlMs' must be ${APPROVAL_TTL_RULE}, got ${String(value)}.`, 'approvalTtlMs');
}

/** `maxHandoffs` must be a whole number >= 0. */
function assertMaxHandoffs(value: unknown): void {
  if (value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0)) return;
  throw new ConfigurationError(`createAgent: 'maxHandoffs' must be a whole number >= 0, got ${String(value)}.`, 'maxHandoffs');
}

/** A run's tool registry, the matching `AgentConfig.tools`, and its hosted tools. */
type RunTools = ReturnType<typeof registerTools> & { hostedTools: HostedTool[] };

/**
 * The `tools` option split into the local tools to register and the
 * hosted tools for the provider. In the record form a hosted tool's key must
 * be its name (the provider maps the tool by it).
 */
function splitHostedTools(tools: AgentToolsOption | undefined): { local: ToolEntries; hosted: HostedTool[] } {
  const local: Array<readonly [string, ToolDescriptor]> = [];
  const hosted: HostedTool[] = [];
  // Arrays, records and mixes of both flatten to [name, tool] entries.
  for (const [name, tool] of toolEntries(tools, 'createAgent')) {
    if (!isHostedTool(tool)) {
      local.push([name, tool]);
      continue;
    }
    if (name !== tool.name) {
      throw new ConfigurationError(
        `createAgent: hosted tool '${tool.name}' is under the key '${name}' in \`tools\`; use '${tool.name}' as its key ` +
          `(or create it with hostedTool('${name}', ...)).`,
        'tools'
      );
    }
    hosted.push(tool);
  }
  return { local, hosted };
}

/**
 * Adds connected MCP tools to a run's tools. an MCP tool
 * may not take the name of another tool (it would replace it and its approval gate).
 */
function addMcpTools(target: RunTools, tools: Record<string, ToolDescriptor>): void {
  for (const [name, descriptor] of Object.entries(tools)) {
    const existing = target.toolRegistry?.get(name);
    if (existing && existing !== descriptor) {
      throw new ConfigurationError(
        `createAgent: MCP tool '${name}' has the same name as another tool of this agent. ` +
          'Rename the local tool, or leave the MCP tool out with the server entry `tools: { exclude }`.',
        'mcpServers'
      );
    }
    target.toolRegistry?.register(name, descriptor);
    target.toolsConfig[name] = { tool: name };
  }
}

/** Removes an MCP tool a server no longer offers from a run's tools. */
function removeMcpTool(target: RunTools, name: string, descriptor: ToolDescriptor): void {
  if (target.toolRegistry?.get(name) !== descriptor) return;
  target.toolRegistry.unregister(name);
  delete target.toolsConfig[name];
}

/** What a paused or interrupted dynamic run is resumed with: its `ctx`, and the model it ran with (never re-resolved). */
interface PinnedRunConfig {
  ctx: RunConfigContext;
  model: string | undefined;
}

/** `config.onEvent` plus a turn's own listener (a session's `on()` forwarder), as one `onAgentEvent`. */
function mergedAgentEvent(
  agent: ((event: AgentEvent) => void) | undefined,
  turn: ((event: AgentEvent) => void) | undefined
): ((event: AgentEvent) => void) | undefined {
  if (!agent || !turn) return agent ?? turn;
  return (event) => {
    agent(event);
    turn(event);
  };
}

/**
 * `ctx` with the metadata and principal the unfinished run checkpointed for
 * `turn` was saved with, where the call gives none (a `resume()`, or a `send()`
 * that resumes a pending turn first), so memory scoped by them binds the same
 * slots and the run's pending memory calls find their tools.
 */
async function savedRunContext(ctx: RunConfigContext, turn: SessionTurnOptions | undefined): Promise<RunConfigContext> {
  if (!turn?.sessionId || !turn.checkpointStore || (ctx.metadata !== undefined && ctx.principal !== undefined)) return ctx;
  const checkpoint = await turn.checkpointStore.load(turn.sessionId);
  if (!checkpoint || checkpoint.status === 'finished') return ctx;
  const metadata = ctx.metadata ?? checkpoint.metadata;
  const principal = ctx.principal ?? checkpoint.principal;
  return { ...ctx, ...(metadata !== undefined && { metadata }), ...(principal !== undefined && { principal }) };
}

/** The `ctx` and model of the unfinished run checkpointed for `turn`, if there is one. */
async function checkpointedRunConfig(turn: SessionTurnOptions | undefined): Promise<PinnedRunConfig | undefined> {
  if (!turn?.sessionId || !turn.checkpointStore) return undefined;
  const checkpoint = await turn.checkpointStore.load(turn.sessionId);
  return checkpoint && checkpoint.status !== 'finished' ? (checkpoint.runConfig as PinnedRunConfig | undefined) : undefined;
}

type RunOptions = Omit<SubagentSpec, 'agent' | 'provider' | 'toolRegistry'> & { onAgentDrift?: AgentDriftMode };

/** The agent's run specs: `static` when no option is a function, else `resolve(ctx)` builds one per run. */
interface AgentSpecs {
  static?: SubagentSpec;
  /** The tools when `tools` is static: shared by every run, MCP tools are added to them. */
  staticTools?: RunTools;
  resolve: (ctx: RunConfigContext, pinned?: PinnedRunConfig) => Promise<SubagentSpec>;
}

function agentSpecs(
  config: CreateAgentConfig,
  toolsFor: (tools: AgentToolsOption | undefined) => RunTools,
  runOptions: RunOptions,
  resolved: AgentInstructions
): AgentSpecs {
  const { instructions, option } = resolved;
  const projectBlock = projectInstructionsBlock(config.projectInstructions);
  const provider = isPerRun(config.model) ? undefined : resolveModelSource(config, config.model);
  const staticTools = isPerRun(config.tools) ? undefined : toolsFor(config.tools);
  const agentId = newId();
  const specOf = (prompt: string | undefined, model: string | undefined, runProvider: LLMProvider, tools: RunTools): SubagentSpec => {
    const builder = AgentBuilder.create()
      .setId(agentId)
      .setName(config.name || DEFAULT_AGENT_NAME)
      .setPrompt((prompt ?? DEFAULT_INSTRUCTIONS) + projectBlock)
      .setTools(tools.toolsConfig);
    // With an explicit provider, `model` is a per-agent model setting.
    if (config.provider && model) builder.setSettings({ model });
    return {
      agent: builder.build(),
      provider: runProvider,
      toolRegistry: tools.toolRegistry,
      ...(tools.hostedTools.length > 0 && { hostedTools: tools.hostedTools }),
      ...runOptions,
    };
  };
  const resolve = async (ctx: RunConfigContext, pinned?: PinnedRunConfig): Promise<SubagentSpec> => {
    const model = pinned ? pinned.model : await resolveOption('model', config.model, ctx);
    const prompt = await resolveOption(option, instructions, ctx);
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

/** `value`, or what its function returns for `ctx`; a throw becomes LOUSHO_CONFIG_RESOLVER_FAILED naming `option`. */
async function resolveOption<T>(option: string, value: PerRun<T>, ctx: RunConfigContext): Promise<T> {
  if (!isPerRun(value)) return value;
  try {
    return await value(ctx);
  } catch (error) {
    throw new ConfigurationError(
      `createAgent: the '${option}' function threw while resolving this run's config: ${error instanceof Error ? error.message : String(error)}`,
      option,
      'LOUSHO_CONFIG_RESOLVER_FAILED',
      { cause: error }
    );
  }
}

/** How a paused run continues: with the spec (and, for a dynamic run, the model) it paused with. */
function resumeRequester(deps: {
  specs: AgentSpecs;
  handoffs: ReturnType<typeof handoffRunner>;
  runOptions: RunOptions;
  config: CreateAgentConfig;
  hooks: HookRegistry | undefined;
  checkpoints: CheckpointStore | undefined;
  tokens: OAuthTokenStore | undefined;
  tracing: Pick<ExecuteOptions, 'exporter' | 'captureContent' | 'redactContent'>;
  memory: AgentMemory | undefined;
}) {
  const { specs, handoffs, runOptions, config, hooks, checkpoints, tokens, tracing, memory } = deps;
  return async (
    approvalStore: ApprovalStore,
    decision: ApprovalDecision,
    signal?: AbortSignal,
    checkpointStore?: CheckpointStore,
    permissionMode?: PermissionOptions['permissionMode'],
    approver?: Principal,
    onAgentEvent?: (event: AgentEvent) => void
  ): Promise<ResumeRequest> => {
    // A run paused after a handoff continues as the agent it handed off to.
    const paused = await pausedRun(specs, approvalStore, decision.id, handoffs.has() ? handoffs : undefined);
    const { agent: pausedAgent, provider, hostedTools, ...pausedOptions } = paused.spec;
    const bound = await pausedMemory(memory, paused, approvalStore, decision.id, hooks);
    const { toolRegistry } = bound;
    return {
      decision,
      approvalStore: paused.store,
      toolRegistry: toolRegistry ?? new ToolRegistry(),
      provider,
      executeOptions: {
        ...runOptions,
        ...pausedOptions,
        // A paused session turn continues under the session's mode (read at each call), else the agent's.
        ...(permissionMode !== undefined && { permissionMode }),
        output: config.output,
        hooks: bound.hooks,
        approvalStore: paused.store,
        signal,
        currentAgent: pausedAgent,
        hostedTools,
        ...(paused.handoffs && { handoffs: paused.handoffs, maxHandoffs: config.maxHandoffs }),
        // `onAgentEvent` is the paused session's on() forwarder when the run is continued in one.
        onAgentEvent: mergedAgentEvent(config.onEvent, onAgentEvent),
        ...tracing,
        // Who decides; the run itself goes on as the principal it paused with (its snapshot's).
        ...(approver && { approver }),
        // A sign-in pause continues once the user's token is in the store.
        ...(tokens && { tokens }),
      },
      // A run paused under a `sessionId` keeps checkpointing after the decision.
      checkpointStore: checkpointStore ?? checkpoints,
    };
  };
}

/** The tools and hooks a paused run continues with: the memory tools and recall it had, bound to the scope keys it paused with. */
async function pausedMemory(
  memory: AgentMemory | undefined,
  paused: { spec: SubagentSpec; snapshot?: ExecutionSnapshot },
  approvalStore: ApprovalStore,
  approvalId: string,
  hooks: HookRegistry | undefined
): Promise<{ toolRegistry: ToolRegistry | undefined; hooks: HookRegistry | undefined }> {
  const snapshot = memory && (paused.snapshot ?? (await approvalStore.load?.(approvalId))?.snapshot);
  if (!memory || !snapshot) return { toolRegistry: paused.spec.toolRegistry, hooks };
  return memory.forRun({ sessionId: snapshot.contextSessionId ?? snapshot.sessionId, metadata: snapshot.metadata, principal: snapshot.principal }, paused.spec.toolRegistry, hooks);
}

/** A checkpointed session's turn runs under its own sessionId + checkpointStore. */
function agentSession<Typed>(
  config: CreateAgentConfig,
  approvals: ReturnType<typeof createAgentApprovals>,
  run: (input: Message[], ctx: RunConfigContext, signal?: AbortSignal, turn?: RunTurn, inSession?: boolean) => Promise<ExecutionResult>,
  stream: (input: Message[], ctx: RunConfigContext, signal?: AbortSignal, turn?: RunTurn, inSession?: boolean) => AgentRun
): (options?: SessionOptions) => AgentSession<Typed> {
  const session = (options: SessionOptions = {}): AgentSession<Typed> => {
    // The id is chosen here so memory scoped to the session sees it on every turn.
    const sessionId = options.id ?? globalThis.crypto.randomUUID();
    const ctxOf = (input: Message[], call?: SessionTurnCall): RunConfigContext => ({
      sessionId,
      input: call?.input ?? input,
      metadata: call?.metadata,
      principal: call?.principal,
    });
    return approvals.session(
      // A session's turn continues with the agent its transcript last handed off to.
      (input, signal, turn, call) => run(input, ctxOf(input, call), signal, turn, true),
      (input, signal, turn, call) => stream(input, ctxOf(input, call), signal, turn, true),
      // Follow-up: `session.compact()` uses the agent's `compaction` unless the session sets its own; the same for the permission mode.
      withDefaultStores(
        {
          ...options,
          compaction: options.compaction ?? config.compaction,
          permissionMode: options.permissionMode ?? config.permissionMode,
          onPermissionModeChange: options.onPermissionModeChange ?? config.onPermissionModeChange,
          id: sessionId,
        },
        config.store
      ),
      // A fork is a session of this agent, so memory scoped to the session sees the fork's id.
      session
    ) as AgentSession<Typed>;
  };
  return session;
}

/**
 * The spec a paused run resumes with. A dynamic run takes its approval
 * (to read the `ctx` and model it was paused with) and hands it back to
 * `resumeAfterApproval()` through a store that replays it once.
 */
async function pausedRun(
  specs: AgentSpecs,
  store: ApprovalStore,
  id: string,
  handoffs?: ReturnType<typeof handoffRunner>
): Promise<{ spec: SubagentSpec; store: ApprovalStore; handoffs?: ResolvedHandoffs; snapshot?: ExecutionSnapshot }> {
  if (specs.static && !handoffs) return { spec: specs.static, store };
  const record = await store.resolve(id);
  if (!record) {
    throw new SDKError(`No pending approval found for id '${id}' (unknown or already resolved)`, 'LOUSHO_APPROVAL_NOT_FOUND');
  }
  const pinned = record.snapshot.agent.metadata?.[RUN_CONFIG_KEY] as PinnedRunConfig | undefined;
  const { snapshot } = record;
  // The agent the paused run's transcript last handed off to (the run's own agent without a handoff).
  const resolved = handoffs && (await handoffs.run(activeAgentOf(snapshot.currentMessages), pinned?.ctx ?? { input: [], principal: snapshot.principal }, pinned));
  const spec = resolved ? resolved.spec : await specs.resolve(pinned?.ctx ?? { input: [] }, pinned);
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
  return { spec, store: replayStore, snapshot, ...(resolved && { handoffs: resolved.handoffs }) };
}

type ResolvedHandoffs = ExecuteOptions['handoffs'];

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

/** The instructions the agent resolves per run, and how they got there. */
interface AgentInstructions {
  /** `PerRun` the run resolves: fetched registry text, the embedded value, or a function of the run (undefined = the default). */
  instructions: PerRun<string | undefined> | undefined;
  /** The option name resolver errors blame ('prompt' only when the legacy alias carries the instructions). */
  option: 'instructions' | 'prompt';
  /** The reporter's `prompt_use` provider when a registry prompt is in play. */
  promptUse?: PromptUseProvider;
}

/**
 * The system prompt the agent runs with: embedded `instructions` (or the
 * deprecated `prompt` alias), UNLESS a registry ref is in play -
 * `createAgent({ prompt: 'name@version' })`, or `LOUSHO_PROMPT` when
 * `prompt` is unset. Then the daemon's text wins and the embedded value is
 * the fallback for an unreachable daemon (`LOUSHO_OBSERVE` names it; the
 * fetch starts at build and is memoized - see promptClient.registryPrompt).
 *
 * An explicit `prompt` always beats `LOUSHO_PROMPT`; both `instructions`
 * and `prompt` together are an error unless `prompt` is a registry ref
 * (then `instructions` is the documented fallback).
 */
function agentInstructions(config: CreateAgentConfig): AgentInstructions {
  const promptIsRef = typeof config.prompt === 'string' && parsePromptRef(config.prompt) !== undefined;
  if (config.instructions !== undefined && config.prompt !== undefined && !promptIsRef) {
    throw new ConfigurationError(
      "createAgent: both 'instructions' and 'prompt' were given. They are the same option - " +
        "use 'instructions' (and drop 'prompt', its alias - it only differs from it as a 'name@version' registry reference).",
      'prompt',
      'LOUSHO_CONFIG_CONFLICTING_OPTIONS'
    );
  }
  const env = typeof process !== 'undefined' ? process.env : undefined;
  const ref = promptIsRef ? (config.prompt as string) : config.prompt === undefined ? env?.LOUSHO_PROMPT : undefined;
  const fetched = ref !== undefined ? registryPrompt(ref, { env }) : undefined;
  if (ref !== undefined && fetched === undefined) {
    console.warn(
      `[lousho] prompt: '${ref}' needs a collector to resolve - set LOUSHO_OBSERVE=1 (or a daemon URL); the embedded instructions are used instead.`
    );
  }
  const embedded = promptIsRef ? config.instructions : (config.instructions ?? config.prompt);
  if (fetched === undefined) {
    return { instructions: embedded, option: config.prompt === undefined ? 'instructions' : 'prompt' };
  }
  return {
    option: 'instructions',
    promptUse: fetched.use,
    instructions: (ctx) => fetched.text(() => (embedded === undefined ? Promise.resolve(undefined) : resolveOption('instructions', embedded, ctx))),
  };
}

/** The default `retry` for models given as strings: as many retries as the `ai` SDK makes on its own. */
const DEFAULT_RETRY: WithRetryOptions = { maxRetries: 2 };

/**
 * The provider to run with: the given instance, else `model` resolved (else
 * the env's choice), wrapped in `withRetry()` and, with `fallbackModels`,
 * `withFallback()`. `model` is the run's.
 */
function resolveModelSource(config: CreateAgentConfig, model: string | undefined): LLMProvider {
  const { retry, fallbackModels = [] } = config;
  const resolve = (spec: string) => {
    // maxRetries: 0 turns off the 'ai' SDK's own retries: withRetry() is the only layer.
    const provider = resolveProviderSpec(spec, 'createAgent', LLMProviderRegistry, { maxRetries: 0 });
    return retry === false ? provider : withRetry(provider, retry ?? DEFAULT_RETRY);
  };
  let primary: LLMProvider;
  if (config.provider) {
    // `false` sends each call once - a 0-retry withRetry() turns the 'ai' SDK's own retries off too.
    // Without `retry`, an 'ai'-SDK-backed instance retries like a string model (its own maxRetries, default 2).
    const instanceRetries = retry === undefined ? defaultAgentRetries(config.provider) : undefined;
    primary =
      retry === undefined
        ? instanceRetries === undefined
          ? config.provider
          : withRetry(config.provider, { maxRetries: instanceRetries })
        : withRetry(config.provider, retry || { maxRetries: 0 });
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
  tools: ToolEntries,
  alwaysRegistry = false
): {
  toolRegistry: ToolRegistry | undefined;
  toolsConfig: Record<string, { tool: string }>;
} {
  const toolsConfig: Record<string, { tool: string }> = {};

  if (tools.length === 0 && !alwaysRegistry) {
    return { toolRegistry: undefined, toolsConfig };
  }

  const toolRegistry = new ToolRegistry();
  for (const [name, descriptor] of tools) {
    // A `defineTool()` result under its own name keeps the duplicate-check
    // of registerDefined; anything else registers under the key it came with
    // (a record's key, or a named descriptor's own `name`).
    if (isDefinedTool(descriptor) && descriptor.name === name) {
      toolRegistry.register(descriptor);
    } else {
      toolRegistry.register(name, descriptor);
    }
    toolsConfig[name] = { tool: name };
  }
  return { toolRegistry, toolsConfig };
}
