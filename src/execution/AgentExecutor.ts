/**
 * Agent Executor
 * Executes agents with streaming support and tool calling
 */

import type { Skill } from '../skills/defineSkill';
import { withSkills } from '../skills/withSkills';
import type { Subagents } from '../subagents/types';
import type { BackgroundTaskView } from '../subagents/backgroundTasks';
import { assertMaxSubagentDepth, withSubagents } from '../subagents/withSubagents';
import type { StandardSchemaV1 } from '../utils/zodCompat';
import { newId } from '../utils/id';
import { LLMProvider, Message, ToolCall, GenerateOptions, GenerateResult, ToolDefinition, type ReasoningOption } from '../providers';
import { AgentConfig } from '../types';
import { ToolRegistry } from '../tools';
import { SandboxAdapter, NoopSandbox } from '../security/sandboxCore';
import { ApprovalStore, describeApproval, ExecutionSnapshot, PendingApproval, SubagentSuspension } from './ApprovalGate';
import { CheckpointStore, ForkOptions, ForkResult } from './checkpoint';
import type { AgentDriftMode } from './agentFingerprint';
import type { Principal } from '../auth/types';
import { forkSession } from './fork';
import type { CallUsage, RunUsage, StepUsage } from '../models/usage';
import { mergeDelegatedUsage } from './runUsage';
import { TraceExporter, withSpan } from './tracing';
import {
  agentRunSpanInit,
  recordToolOutcome,
  resolveCaptureContent,
  toolSpanInit,
} from './genAiSpans';
import { HookRegistry, type SubagentInfo } from './hooks';
import {
  baseAgentOf,
  extendAgent,
  settleSuspensions,
  suspensionRecord,
  type ToolCallScope,
} from './subagentRuntime';
import { ConfigurationError, isAbortError } from './errors';
import type { HostedTool } from '../tools/hosted';
import { assertHostedToolsSupported, countHostedCalls, withHostedCalls } from './hostedToolCalls';
import {
  PreparedToolCall,
  ToolCallContext,
  ToolCallOutcome,
  parseToolArguments,
  runToolCall,
} from './toolCallExecution';
import {
  StartedToolCall,
  ToolBatchResult,
  ToolConcurrency,
  assertToolConcurrency,
  runToolBatch,
} from './toolBatch';
import {
  buildTools,
  compactGenerateError,
  GeneratedStep,
  generateInSpan,
  prepareGenerateRequest,
  providerErrorMessage,
  shouldSurfaceToModel,
} from './generateStep';
import {
  AgentRunState,
  assistantTurn,
  checkResumedAgent,
  ensureFingerprint,
  loadRunState,
  pushAbortedBatchResults,
  noteReasoning,
  pushToolResult,
  recordStep,
  saveStepCheckpoint,
  toExecutionResult,
} from './agentRunState';
import { AgentRun, RUN_EVENTS, StreamingExecuteOptions, observeRun, runEventsOf, startAgentRun } from './agentRun';
import type { AgentEvent } from './agentEvents';
import { withSteerSignal, type InputQueue } from './inputQueue';
import { OutputError, outputInstruction, outputRepairMessage, validateOutput } from './structuredOutput';
import { PLAN_MODE_INSTRUCTION, permissionModeOf, type PermissionOptions } from './permissions';
import {
  BudgetExceeded,
  BudgetExceededError,
  RunBudget,
  RunLimits,
  SessionBudget,
  budgetOfAbort,
  maxStepsOf,
  startBudget,
} from './budget';
import { GuardrailError, checkInputGuardrails, checkOutputGuardrails, type AgentGuardrails, type GuardrailTrip } from './ioGuardrails';

export { PropagatingToolError } from './propagatingToolError';

/**
 * Execution event types.
 *
 * @deprecated LOU-D41: the old event names. Listen to {@link AgentEvent}s
 * instead (`onAgentEvent`, `createAgent({ onEvent })`, `stream()`); see the
 * migration table in docs/streaming.md#listening-without-iterating.
 */
export type ExecutionEventType =
  | 'start'
  | 'text-delta'
  | 'text-complete'
  | 'tool-call'
  | 'tool-result'
  | 'finish'
  | 'error'
  | 'abort';

/**
 * Why a run ended, as reported on `ExecutionResult.finishReason` and the
 * `finish` event. The known values are listed for autocomplete; a provider
 * may report others, so this stays open to any string.
 *
 * - `'stop'`, `'length'`, `'tool_calls'`, `'content_filter'`, `'error'`:
 *   the model's own finish reason for its last turn.
 * - `'awaiting-approval'`: paused on a tool call that needs a human
 *   decision (see `resumeAfterApproval()`).
 * - `'aborted'`: cancelled through `ExecuteOptions.signal` (LOU-V1).
 * - `'max-steps'`: the `maxSteps` budget ran out while the model still
 *   wanted to continue (LOU-U19). A run that finishes naturally within the
 *   budget keeps the model's own reason (usually `'stop'`).
 * - `'output-invalid'`: the run has an `output` schema and the final reply
 *   was still not valid JSON matching it after one repair step (LOU-V4);
 *   see `ExecutionResult.outputError`.
 * - `'budget-exceeded'`: a `limits` budget tripped (LOU-V6); see
 *   `ExecutionResult.budget`.
 * - `'guardrail'`: an input, output or tool guardrail blocked (LOU-X4); see
 *   `ExecutionResult.guardrail`.
 */
export type ExecutionFinishReason =
  | GenerateResult['finishReason']
  | 'awaiting-approval'
  | 'aborted'
  | 'max-steps'
  | 'output-invalid'
  | 'budget-exceeded'
  | 'guardrail'
  | (string & {});

/**
 * Execution event, as the deprecated `onEvent` listener receives it.
 *
 * @deprecated LOU-D41: derived from the run's {@link AgentEvent}s for old
 * listeners. Use `onAgentEvent` / `createAgent({ onEvent })` with
 * `AgentEvent` instead; see docs/streaming.md#listening-without-iterating.
 */
export interface ExecutionEvent {
  type: ExecutionEventType;
  timestamp: Date;
  agentId?: string;
  agentName?: string;
  textDelta?: string;
  text?: string;
  toolCall?: ToolCall;
  toolResult?: {
    toolCallId: string;
    toolName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deprecated public type, kept for compatibility (LOU-D41)
    result: any;
    error?: string;
    /** LOU-X3: the hook whose `{ result }` outcome became this call's result. */
    replacedByHook?: string;
  };
  finishReason?: ExecutionFinishReason;
  /** Running usage of the whole run so far (LOU-V5); on `finish`, the final total. */
  usage?: RunUsage;
  /** On `text-complete`: what the model call that produced the text spent (LOU-V5). */
  stepUsage?: StepUsage;
  error?: Error;
  /**
   * On an `abort` event: the `reason` of the aborted signal (a
   * `DOMException` named `AbortError` unless the caller passed their own
   * reason to `controller.abort(reason)`).
   */
  abortReason?: unknown;
  /**
   * LOU-Y1: set on events forwarded from a sub-agent (a child run started
   * by the `task` tool or a `createDelegateTool()` tool): which sub-agent
   * emitted it and which of this run's tool calls started it. Absent on the
   * run's own events.
   */
  subagent?: SubagentInfo;
}

/**
 * Execution options
 */
export interface ExecuteOptions extends PermissionOptions {
  agent: AgentConfig;
  input: string | Message[];
  provider: LLMProvider;
  toolRegistry?: ToolRegistry;
  /**
   * N1a: tools the provider runs itself (`webSearch()`, `codeInterpreter()`,
   * `fileSearch()`, `hostedTool()`), sent with every model call of the run.
   * The run rejects with `LOUSHO_HOSTED_TOOL_UNSUPPORTED` when the provider
   * cannot send one (`provider.supportsHostedTool`). Their calls pass no
   * permission rule, guardrail, approval or hook: the provider runs them
   * inside the request. `createAgent()` sets this from `tools`.
   */
  hostedTools?: readonly HostedTool[];
  /**
   * Skills (LOU-Y2): instructions the model loads on demand. Their names and
   * descriptions are appended to the system prompt and a `load_skill` tool is
   * registered; bodies only enter the conversation when the model loads them.
   * Throws if a tool named `load_skill` is already registered.
   *
   * @example
   * AgentExecutor.execute({ agent, input, provider, skills: [defineSkill({ name, description, content })] });
   */
  skills?: readonly Skill[];
  /**
   * Sub-agents (LOU-Y3) this agent can delegate to: a record of
   * `createAgent()` agents keyed by name (each needs a `description`), or a
   * dynamic `{ list, resolve }` catalog (listed at the start of each run).
   * Registers ONE `task` tool (`{ agent, prompt, description }`) and lists the
   * sub-agents in the system prompt. A sub-agent sees only the `prompt`, and
   * inherits this run's signal, hooks, tracing, approval store,
   * `toolConcurrency` and event listeners (see docs/sub-agents.md). Throws
   * if a tool named `task` is already registered.
   *
   * @example
   * AgentExecutor.execute({ agent, input, provider, subagents: { researcher, writer } });
   */
  subagents?: Subagents;
  /**
   * How deep sub-agents may nest (LOU-Y3). Defaults to 1: the lead agent can
   * call sub-agents, but they cannot call sub-agents of their own. A run at
   * the limit is simply not offered the `task` tool. The top-level run's
   * value applies to the whole tree.
   */
  maxSubagentDepth?: number;
  /**
   * Span id to parent this run's `invoke_agent` span to (LOU-Y1). Set
   * automatically for a sub-agent, whose span becomes a child of the
   * parent's `execute_tool` span; set it yourself to nest a run inside your
   * own trace.
   */
  parentSpanId?: string;
  maxSteps?: number;
  /**
   * LOU-V6: token, cost, time and step budgets of this run, checked before
   * every model call and after one that asks for tools; `maxDurationMs` also
   * aborts in-flight calls. A tripped limit ends the run with
   * `finishReason: 'budget-exceeded'` and `result.budget` (or throws
   * `BudgetExceededError` with `onExceeded: 'throw'`). See docs/configuration.md#budgets.
   *
   * @example
   * ```ts
   * await AgentExecutor.execute({ agent, input: 'Research this', provider, limits: { maxCostUsd: 0.5, maxDurationMs: 60_000 } });
   * ```
   */
  limits?: RunLimits;
  /**
   * LOU-X4: input, output and tool guardrails. A block ends the run with
   * `finishReason: 'guardrail'` and `result.guardrail` (or throws
   * `GuardrailError` with `onTripped: 'throw'`); an input block makes no
   * model call. Sub-agents inherit them. See docs/guardrails.md.
   */
  guardrails?: AgentGuardrails;
  /** LOU-V6: a session's `limits` and what its earlier turns spent; set by `agent.session({ limits })`. */
  sessionBudget?: SessionBudget;
  temperature?: number;
  maxTokens?: number;
  /**
   * LOU-D41: called with every {@link AgentEvent} of the run, synchronously
   * as it happens - the same events, in the same order, as `stream()`
   * yields, on `execute()` too. M9: with a listener, `execute()` streams each
   * model call when the provider can, so a step's text arrives as several
   * `text.delta` events, as on `stream()` (see {@link ExecuteOptions.streamModelCalls}).
   * Sub-agents' events arrive tagged with `subagent`. See docs/streaming.md#listening-without-iterating.
   *
   * @example
   * ```ts
   * await AgentExecutor.execute({ agent, input: 'Hi', provider, onAgentEvent: (event) => console.log(event.type) });
   * ```
   */
  onAgentEvent?: (event: AgentEvent) => void;
  /**
   * @deprecated LOU-D41: use {@link ExecuteOptions.onAgentEvent}. Still
   * called, with {@link ExecutionEvent}s derived from the run's AgentEvents
   * (a one-time `console.warn` says so).
   */
  onEvent?: (event: ExecutionEvent) => void;
  /**
   * M9: whether a run with listeners (`onAgentEvent` / `onEvent`) streams its
   * model calls through `provider.stream()` when the provider can, so each
   * step's text reaches the listeners as several `text.delta` events.
   * Default `true`; `false` generates each step whole (one `text.delta` per
   * step). Ignored by `stream()`, which always streams, and by a run without
   * listeners, which always generates.
   *
   * @example
   * ```ts
   * await AgentExecutor.execute({ agent, input: 'Hi', provider, onAgentEvent, streamModelCalls: false });
   * ```
   */
  streamModelCalls?: boolean;
  approvalStore?: ApprovalStore;
  /**
   * Durable execution: with `checkpointStore`, the run is checkpointed under
   * this id after every model response, as tool results are recorded, and
   * when it pauses, aborts or finishes. Calling `execute()` again with the
   * same id (from any process) picks the session up (LOU-U8):
   *
   * - Unfinished run (crashed or aborted): resumes it. Tool calls of its last
   *   model turn that have no result run first, without calling the model.
   *   New `input` is appended as a user message after those results; input
   *   that re-sends the run's own starting message is treated as a retry
   *   and not appended again (`input: []` also just resumes).
   * - Finished run: continues the conversation - the stored messages are
   *   kept and `input` is appended as the next user turn. Pass only the new
   *   message(s); a re-sent copy of the stored history is not duplicated.
   *   `steps`, `usage` and `toolCalls` count from zero for the new run.
   * - Paused awaiting approval: throws `SessionAwaitingApprovalError`;
   *   resolve it with `resumeAfterApproval()` first.
   *
   * A tool that was running when the process died runs again on resume
   * (at-least-once): make side-effecting tools idempotent - e.g. keyed on
   * the `toolCallId` their `execute` receives - or approval-gated.
   * Delete the session with `checkpointStore.delete(sessionId)`.
   *
   * @example
   * ```ts
   * await AgentExecutor.execute({ agent, input: 'Book a table for 2', provider, sessionId: 'chat-42', checkpointStore });
   * await AgentExecutor.execute({ agent, input: 'Make it 3 people', provider, sessionId: 'chat-42', checkpointStore });
   * ```
   */
  sessionId?: string;
  /**
   * N10b: who the run acts for (docs/auth.md): handed, frozen, to tools
   * (`ctx.principal`), `needsApproval` policies, permission rules, tool-call
   * hooks and in-process sub-agents, and stored with checkpoints and approval
   * snapshots. Set it only from route auth or a channel's verified sender.
   * An unfinished checkpointed run continues as the principal it was saved
   * with; passing a different one throws `LOUSHO_CONFIG_INVALID`.
   */
  principal?: Principal;
  /** Where `sessionId` checkpoints are stored - see `sessionId` for the semantics. */
  checkpointStore?: CheckpointStore;
  /**
   * When true, `input` is treated as a complete, ready-to-send message
   * array that already includes any system prompt it needs (e.g. messages
   * reconstructed from an ExecutionSnapshot by resume.ts). buildMessages()
   * will not prepend a fresh system message built from `agent.prompt` in
   * this case, avoiding a duplicate system message. Only relevant on the
   * "build from scratch" fallback path (no checkpoint loaded); ignored
   * when a checkpoint is rehydrated, since that path never re-injects a
   * system message anyway.
   */
  skipSystemPromptInjection?: boolean;
  /**
   * Starting value for the step counter (and therefore the maxSteps
   * safety-limit budget), used when there is no checkpoint to rehydrate
   * `steps` from but execution is still a continuation of prior work - e.g.
   * resume.ts resuming a run that was paused for approval after already
   * taking some steps. Ignored whenever a checkpoint is loaded, since
   * `checkpoint.stepIndex` is the source of truth in that case. Defaults to
   * 0 (a genuinely fresh run) when omitted.
   */
  initialSteps?: number;
  /**
   * Usage already spent by earlier work this run continues (LOU-V5), used
   * when there is no checkpoint to rehydrate it from - e.g. resume.ts
   * resuming a run paused for approval. Ignored when a checkpoint is loaded.
   */
  initialUsage?: RunUsage;
  /**
   * Tracing/observability hooks (LOU-E1/E2). These are invoked immediately
   * before/after the underlying provider.generate() call and each tool
   * execution inside executeToolCall(). They are plain synchronous or
   * async callbacks - errors thrown from them are NOT swallowed and will
   * propagate out of execute() like any other error, since a hook that
   * silently fails to observe would be worse than one that fails loudly.
   */
  /** Invoked immediately before each provider.generate() call. */
  onLLMRequest?: (request: GenerateOptions) => void | Promise<void>;
  /**
   * Invoked immediately after each provider.generate() call resolves,
   * with the elapsed wall-clock time in milliseconds and what the call
   * spent (LOU-V5: reported usage, or an estimate flagged `estimated`).
   */
  onLLMResponse?: (
    response: GenerateResult,
    latencyMs: number,
    usage: CallUsage
  ) => void | Promise<void>;
  /** Invoked immediately before each tool execution. */
  onToolCall?: (toolCall: ToolCall) => void | Promise<void>;
  /**
   * Invoked immediately after each tool execution settles (success or
   * error), with the elapsed wall-clock time in milliseconds. Fired from a
   * `finally` block so it runs even when the tool throws.
   */
  onToolResult?: (
    toolCall: ToolCall,
    result: {
      toolCallId: string;
      toolName: string;
      result: unknown;
      error?: string;
      requiresApproval?: boolean;
      args?: Record<string, unknown>;
    } | undefined,
    latencyMs: number,
    error?: unknown
  ) => void | Promise<void>;
  /**
   * Trace exporter (LOU-E3/E4/E5). When provided, execute() wraps its run
   * in a 3-level span tree following the OpenTelemetry GenAI conventions
   * (LOU-D9): an `invoke_agent {name}` span, with a nested `chat {model}`
   * span around each provider.generate() call and a nested
   * `execute_tool {tool}` span around each tool execution, both parented to
   * the agent span via Span.parentId. Omitted (or no exporter) means
   * withSpan() is a no-op wrapper - execute()'s behavior is unchanged.
   */
  exporter?: TraceExporter;
  /**
   * When true, the DEPRECATED span attributes omit potentially sensitive
   * content (`chat` leaves out `prompt` and `execute_tool` leaves out
   * `args`/`result`; the agent span's `input` is not redacted). Token
   * counts, finish reason, tool name and error/latency are never redacted.
   * Defaults to false. The `gen_ai.*` content attributes are governed by
   * `captureContent` instead.
   */
  redactContent?: boolean;
  /**
   * Record message and tool-argument content on the OpenTelemetry GenAI
   * attributes (`gen_ai.input.messages`, `gen_ai.output.messages`,
   * `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`,
   * `gen_ai.tool.call.result`). Off by default; falls back to the
   * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` environment
   * variable when omitted.
   */
  captureContent?: boolean;
  /**
   * SandboxAdapter used for tools flagged `requiresSandbox` (LOU-F5). Since
   * AgentExecutor is a static, instance-free API, this is read per-call
   * (`options.sandbox ?? NoopSandbox`) rather than held as construction
   * state. Defaults to NoopSandbox - the zero-isolation, trusted-host
   * adapter - when omitted, so existing callers see no behavior change.
   */
  sandbox?: SandboxAdapter;
  /**
   * Registered `AgentHook`s (LOU-Q1) to run at each pre/post tool-call and
   * pre/post generate point in the execution loop. Purely additive: when
   * omitted (the default), no hooks run and behavior is byte-for-byte
   * identical to before hooks existed. Hooks run in registration order
   * (see HookRegistry); a hook that throws aborts the current step and
   * propagates out of execute() as a rejected promise, exactly like an
   * unrecovered tool/provider error - it is never silently swallowed.
   *
   * This same option is honored by `resumeAfterApproval()` (resume.ts) for
   * its deferred, post-approval tool execution, so a hook registered here
   * fires consistently regardless of which of the two tool-execution call
   * sites handles a given tool call.
   */
  hooks?: HookRegistry;
  /**
   * LOU-T1: opaque, consumer-owned business/domain state (an order id, a
   * ticket id, a workflow stage, ...) written into every checkpoint record
   * alongside execution state, for the lifetime of this execute() call.
   * See `Checkpoint.businessState` (src/execution/checkpoint.ts) for the
   * full contract - the SDK never reads or interprets this value, it is
   * simply copied verbatim into each checkpoint write below. Purely
   * additive: omitted (the default), the checkpoint record's
   * `businessState` field is simply absent, and behavior is identical to
   * before this option existed.
   */
  businessState?: unknown;
  /**
   * LOU-T4: opt-in to Factor-9-style compaction of a `provider.generate()`
   * failure INTO the conversation (as a small `{error, category, ...}`
   * message the model itself sees on its next turn) for categories where
   * that's actually useful - 'rate-limit', 'timeout' and
   * 'context-length-exceeded' (see `isModelActionableProviderErrorCategory()`
   * in errors.ts). Defaults to `false`.
   *
   * Regardless of this flag, EVERY provider.generate() failure is always
   * compacted via `compactProviderError()` before it reaches a caller - the
   * flag only controls WHERE the compacted form goes:
   *
   * - `false` (default, and the only behavior for 'auth-failure'/'unknown'
   *   regardless of this flag): `execute()` rejects with a
   *   `CompactedLLMProviderError` (small message, no raw response
   *   body/stack, original error on `.cause`). This is a strict, ADDITIVE
   *   improvement over the pre-LOU-T4 behavior of rejecting with whatever
   *   raw error the specific provider adapter happened to throw - an
   *   existing `catch` block keeps working (still a rejected promise, still
   *   `instanceof LLMProviderError`, still has `.message`), it just sees a
   *   smaller/friendlier error object. No opt-in needed for this part: it's
   *   a pure correctness/ergonomics fix in the same spirit as this
   *   codebase's other Strong-scored factors, not a control-flow change.
   * - `true`: for the three model-actionable categories above, the
   *   compacted error is instead pushed onto `messages` (tagged so it's
   *   distinguishable from real user input - see the `[provider-error]`
   *   prefix in providerErrorMessage()) and the loop retries generation, consuming
   *   one `maxSteps` step exactly like any other turn. THIS part is
   *   opt-in-only because it is a genuine behavior change for those three
   *   categories: today they always reject; with this flag set, a
   *   persistently-failing provider call instead keeps consuming steps
   *   until either it succeeds, a non-actionable failure occurs, or
   *   `maxSteps` is exhausted (at which point `execute()` still rejects
   *   with the last compacted error - see finishRun() - rather than
   *   silently returning a hollow "successful" result).
   */
  surfaceRetryableProviderErrors?: boolean;
  /**
   * LOU-V1: cancels the run. The signal is checked before every model call
   * and every tool call, and is forwarded to the provider (as
   * `GenerateOptions.signal`) and to each tool's
   * `execute(args, { abortSignal })` so in-flight work can stop early.
   * Delegated child agents inherit it.
   *
   * An aborted run does NOT reject: it resolves with
   * `finishReason: 'aborted'` and the transcript/steps so far, after
   * emitting an `abort` event and then a `finish` event. A rejection caused
   * by the abort (e.g. an `AbortError` from the provider) counts as the
   * abort, never as a failure. With `sessionId` + `checkpointStore` the
   * state is checkpointed, so calling `execute()` again with the same
   * `sessionId` resumes where the run stopped. An already-aborted signal
   * returns at once without calling the provider.
   *
   * @example
   * ```ts
   * const result = await AgentExecutor.execute({
   *   agent, input: 'Summarize the report', provider,
   *   signal: AbortSignal.timeout(30_000), // or controller.signal
   * });
   * if (result.finishReason === 'aborted') console.log('cancelled');
   * ```
   */
  signal?: AbortSignal;
  /**
   * LOU-V9: input pushed while the run goes on (`inputQueue.push()`), so
   * a non-streaming caller can add to it like `run.enqueue()` does. Each
   * input joins the transcript at the next safe point - after the current
   * step's tool results, before the next model call - and a run whose model
   * just gave its final reply takes another step for it. With checkpointing,
   * an input still waiting rides at the end of every checkpoint, so a crash
   * does not lose it. One queue serves one run. See docs/queue-and-steer.md.
   */
  inputQueue?: InputQueue;
  /**
   * LOU-V3: how many tool calls from ONE model turn may run at the same
   * time. Defaults to `'unbounded'` (every call of the turn runs
   * concurrently); `1` restores strictly sequential execution. Must be a
   * positive integer or `'unbounded'`.
   *
   * Guarantees, whatever the limit:
   * - Tool-result messages are appended to the transcript in the model's
   *   call order, never completion order, so the next provider request is
   *   deterministic.
   * - Calls are started in call order. Each call's `tool-call` event,
   *   `onToolCall`, argument validation, `preToolCall` hooks and
   *   `needsApproval` check run before it starts, one call at a time; its
   *   `tool-result` event fires as soon as it completes (completion order).
   *   With `1`, events alternate call/result exactly as before.
   * - Approval: the first call that needs approval stops the batch. Calls
   *   before it run (concurrently) and are recorded; the run then pauses
   *   on that call (`finishReason: 'awaiting-approval'`); calls after it
   *   never start in this run. `resumeAfterApproval()` records the paused
   *   call's result and then runs the calls after it the same way (LOU-U7).
   * - A failing tool does not affect its siblings - each gets its own error
   *   result. A propagating error (`PropagatingToolError`, a throwing hook)
   *   stops new calls from starting, waits for the running ones, then
   *   rejects `execute()` - no tool is left running detached.
   * - An abort (`signal`) mid-batch resolves with `finishReason: 'aborted'`:
   *   finished calls keep their results, the rest get a "cancelled" result.
   * - With checkpointing, the model's turn is checkpointed before any call
   *   starts, and results as the in-order prefix of finished calls grows,
   *   so a resumed run never re-runs a recorded call.
   *
   * @example
   * ```ts
   * await AgentExecutor.execute({ agent, input: 'Compare 3 cities', provider, toolConcurrency: 2 });
   * ```
   */
  toolConcurrency?: ToolConcurrency;
  /**
   * LOU-V4: a zod schema the final reply must match, as JSON (tools can
   * still be called first). It is validated into `result.object`; an invalid
   * reply gets one repair step (counted against `maxSteps`), then the run
   * ends with `finishReason: 'output-invalid'` and `outputError`. See
   * docs/structured-output.md.
   *
   * @example
   * ```ts
   * const { object } = await AgentExecutor.execute({ agent, input: 'Weather in Paris?', provider, output: z.object({ tempC: z.number() }) });
   * ```
   */
  output?: StandardSchemaV1;
  /**
   * LOU-Y4.2: called exactly once when this run ends, however it ends: with
   * `{ result }` when it resolves (any `finishReason`, including `'aborted'`,
   * `'awaiting-approval'` and `'max-steps'`) or `{ error }` when it rejects.
   * The run settles after it returns; an error it throws rejects the run.
   */
  onRunEnd?: (end: { result?: ExecutionResult; error?: unknown }) => void | Promise<void>;
  /**
   * LOU-W9.2: what to do when a checkpointed run is resumed (`sessionId`
   * + `checkpointStore`, an unfinished run) or paused run is continued
   * (`resumeAfterApproval()`) by an agent that differs from the one that saved
   * it: a different model, tools with other names or input schemas, other
   * instructions. `'warn'` (default) reports an `agent.drift` event and a
   * `console.warn`, then continues; `'error'` rejects with
   * `LOUSHO_AGENT_DRIFT` before any model call or tool runs, leaving the
   * checkpoint untouched; `'ignore'` does nothing. A pending tool call whose
   * tool no longer exists always rejects with `LOUSHO_RESUME_TOOL_MISSING`.
   * Checkpoints and snapshots saved before this option existed are not checked.
   * See docs/durable-execution.md#resuming-with-a-changed-agent.
   */
  onAgentDrift?: AgentDriftMode;
  /**
   * LOU-V13: how much the model reasons, sent on every model call of the run
   * (`GenerateOptions.reasoning`). See docs/reasoning.md.
   */
  reasoning?: ReasoningOption;
}

/**
 * Execution result. `TObject` is the type of `object` - `z.output` of the
 * `output` schema for `createAgent({ output })` agents.
 */
export interface ExecutionResult<TObject = unknown> {
  text: string;
  /** LOU-V13: the model's reasoning text over the run's steps, when it reported any (never part of `text` or `messages` content). */
  reasoning?: string;
  messages: Message[];
  toolCalls: ToolCall[];
  /**
   * Tokens, cost and per-model breakdown of the whole run, including
   * delegated children and steps before a resume (LOU-V5). See `formatUsage()`.
   */
  usage: RunUsage;
  /** One entry per model call of this process's run, in order (LOU-V5). */
  stepUsage?: StepUsage[];
  finishReason: ExecutionFinishReason;
  steps: number;
  approvalId?: string;
  /** LOU-V4: the final reply parsed and validated with `output`; absent unless it was valid. */
  object?: TObject;
  /** LOU-V4: why the final reply did not match `output` (`finishReason: 'output-invalid'`). */
  outputError?: OutputError;
  /** LOU-Y4.2: the run's background sub-agents and their final statuses; absent when it started none. */
  backgroundTasks?: BackgroundTaskView[];
  /** LOU-V6: the limit that ended the run (`finishReason: 'budget-exceeded'`). */
  budget?: BudgetExceeded;
  /** LOU-X4: the guardrail that ended the run (`finishReason: 'guardrail'`). */
  guardrail?: GuardrailTrip;
}

/**
 * Agent Executor
 */
export class AgentExecutor {
  /**
   * Runs the agent to its result. With listeners (`onAgentEvent` /
   * `onEvent`), its model calls are streamed to them (M9; see
   * {@link ExecuteOptions.streamModelCalls}).
   */
  static async execute(options: ExecuteOptions): Promise<ExecutionResult> {
    // AgentExecutor is a static, instance-free API - there is no
    // constructor to guard these, so execute() is the first and only
    // entry point where a missing required option can be caught before it
    // fails deep inside runAgentLoop() with a generic "Cannot read
    // properties of undefined" error (e.g. `provider.generate(...)`
    // throwing because `provider` was never checked).
    this.validateExecuteOptions(options);

    // LOU-D41: the run reports to its listeners through its event sink.
    return observeRun(options, (observed) => {
      // The entire run is wrapped in a top-level 'agent.run' span (LOU-E5),
      // whose `id` is threaded as `parentId` into the nested 'llm.generate'
      // and 'tool.call' spans, giving the 3-level span tree its parent/child
      // relationships without any instance state.
      const init = agentRunSpanInit(observed, resolveCaptureContent(observed.captureContent));
      return withSpan(
        observed.exporter,
        init.name,
        init.attributes,
        async (agentSpan) => this.runWithEnd(observed, agentSpan.id),
        observed.parentSpanId,
        init.kind
      );
    });
  }

  /** runAgentLoop() with `skills`/`subagents` applied, then `onRunEnd` once, however the run ends (LOU-Y4.2). */
  private static async runWithEnd(options: ExecuteOptions, agentSpanId: string): Promise<ExecutionResult> {
    let run = options;
    let end: { result?: ExecutionResult; error?: unknown } = {};
    // LOU-V6: a `maxDurationMs` budget aborts the run's signal.
    const budget = startBudget(options.limits, options.sessionBudget, options.signal);
    try {
      run = await this.withExtensions(budget ? { ...options, signal: budget.signal } : options);
      const result = await this.runAgentLoop(run, agentSpanId, budget);
      end = { result };
      return result;
    } catch (error) {
      end = { error };
      throw error;
    } finally {
      budget?.dispose();
      options.inputQueue?.close();
      await run.onRunEnd?.(end);
    }
  }

  /** Applies `skills` and `subagents`: their prompt blocks and their tools. */
  private static async withExtensions(options: ExecuteOptions): Promise<ExecuteOptions> {
    const skilled = withSkills(options.agent, options.toolRegistry, options.skills);
    const extended = await withSubagents(skilled.agent, skilled.toolRegistry, options.subagents, options);
    // N4: a run that starts in plan mode is told so. LOU-V4: the output instruction goes last in the system prompt.
    const { agent } = extended;
    const blocks = [...(permissionModeOf(options) === 'plan' ? [PLAN_MODE_INSTRUCTION] : []), ...(options.output ? [outputInstruction(options.output)] : [])];
    if (blocks.length === 0) return { ...options, ...extended };
    const instruction = blocks.join('\n\n');
    const prompt = agent.prompt ? `${agent.prompt}\n\n${instruction}` : instruction;
    return { ...options, ...extended, agent: extendAgent(agent, { prompt }) };
  }

  /**
   * Runs the agent like {@link AgentExecutor.execute} - same options, same
   * loop, same `ExecutionResult` - and streams the run as typed
   * `AgentEvent`s (LOU-V2). Model output is streamed through
   * `provider.stream()` when the provider has it (one `text.delta` per
   * chunk); otherwise each step uses `generate()` and emits its text as a
   * single `text.delta`. `onAgentEvent` gets the same events; the other callbacks still fire.
   *
   * The run starts immediately. Iterate the returned {@link AgentRun} for
   * the events, or await `run.result`; breaking out of the `for await`
   * early aborts the run (`result` then resolves with
   * `finishReason: 'aborted'`). Invalid options throw synchronously.
   * See docs/stream-events.md for the event schema.
   *
   * @example
   * ```ts
   * const run = AgentExecutor.stream({ agent, input: 'Weather in Paris?', provider, toolRegistry });
   * for await (const event of run) {
   *   if (event.type === 'text.delta') process.stdout.write(event.text);
   * }
   * const { finishReason } = await run.result;
   * ```
   */
  static stream(options: ExecuteOptions): AgentRun {
    this.validateExecuteOptions(options, 'AgentExecutor.stream');
    return startAgentRun(({ signal, sink, inputQueue }) => {
      const streaming: StreamingExecuteOptions = { ...options, signal, inputQueue, [RUN_EVENTS]: sink };
      return this.execute(streaming);
    }, options.signal, options.inputQueue);
  }

  /**
   * Forks a checkpointed run at an earlier step (LOU-D44): takes the newest
   * entry of `fromStep` in the session's checkpoint history, applies `patch`
   * (rewrite messages, replace a tool result, change `businessState`, queue
   * a user message) and saves it as the `'in-progress'` checkpoint of a new
   * session. The original session is not changed. Throws
   * `LOUSHO_CHECKPOINT_NOT_FOUND` when the history has no such step. See
   * docs/durable-execution.md#fork-and-replay.
   *
   * @example
   * ```ts
   * const fork = await AgentExecutor.fork({ sessionId: 'job-1', fromStep: 1, checkpointStore, patch: { appendInput: 'Use Celsius.' } });
   * await AgentExecutor.execute({ agent, provider, input: [], sessionId: fork.sessionId, checkpointStore });
   * ```
   */
  static fork(options: ForkOptions): Promise<ForkResult> {
    return forkSession(options);
  }

  /**
   * The actual execution loop, split out of execute() so the top-level
   * 'agent.run' span (LOU-E5) can wrap it via withSpan() while still
   * exposing execute() as the same static, instance-free entry point.
   */
  private static async runAgentLoop(
    options: ExecuteOptions,
    agentSpanId: string,
    budget?: RunBudget
  ): Promise<ExecutionResult> {
    const { agent, toolRegistry } = options;
    runEventsOf(options)?.runStart(agent);

    // Build tools
    const tools = buildTools(agent, toolRegistry);
    // N1a: the provider must be able to send every hosted tool.
    assertHostedToolsSupported(options.hostedTools, agent, options.provider);

    const state = await loadRunState(options);
    // N10b: the run's principal, as loaded (an unfinished checkpoint's wins), frozen once. `options` is
    // this run's own copy (withExtensions() made it), and the scope every tool call hands on.
    options.principal = state.principal;
    await checkResumedAgent(options, state, tools);
    state.budget = budget;
    // LOU-X4: the new input is checked before anything else runs.
    const blocked = await checkInputGuardrails(options, [state.messages, state.queuedInput]);
    if (blocked) return this.stopForGuardrail(options, state, blocked);

    options.inputQueue?.listen((queued) => {
      runEventsOf(options)?.inputQueued(queued);
      // LOU-V9: checkpointed at once, so a crash before it is applied does not lose it.
      saveStepCheckpoint(options, state).catch(() => undefined);
    });

    // LOU-U7/U9: a resumed transcript may end with a model turn whose tool
    // calls (some of them) have no result yet - finish those first, without
    // calling the model again.
    if (state.pendingToolCalls.length > 0) {
      const resumed = await this.runStepOrAbort(options, state, () =>
        this.runPendingToolCalls(options, state, agentSpanId)
      );
      if (resumed !== 'continue') {
        return resumed;
      }
    }

    return this.runSteps(options, state, tools, agentSpanId);
  }

  /** The generate -> tools loop of runAgentLoop(), run once `state` is loaded. */
  private static async runSteps(
    options: ExecuteOptions,
    state: AgentRunState,
    tools: ToolDefinition[],
    agentSpanId: string
  ): Promise<ExecutionResult> {
    const { signal } = options;
    const maxSteps = maxStepsOf(options);
    let repaired = false;

    // Execution loop with tool calling. LOU-V1: the signal is checked
    // before every model call (here) and every tool call (runToolCalls()).
    while (state.steps < maxSteps) {
      const stopped = this.stopBeforeStep(options, state);
      if (stopped) {
        return stopped;
      }
      state.steps++;
      this.applyQueuedInput(options, state);

      const outcome = await this.runStepOrAbort(options, state, () =>
        this.runStep(options, state, tools, agentSpanId)
      );
      if (await this.stepsOnForInput(options, state, outcome, maxSteps)) {
        continue;
      }
      if (outcome === 'stop') {
        const output = await this.checkOutput(options, state, !repaired && state.steps < maxSteps);
        if (output === 'repair') {
          repaired = true;
          continue;
        }
        return this.finishRun(options, state, output);
      }
      if (typeof outcome !== 'string') {
        return outcome;
      }
    }

    if (signal?.aborted) {
      return this.abortRun(options, state);
    }
    // LOU-U19: every non-final turn 'continue's, so leaving the loop here
    // means the step budget (counting `initialSteps` of a resumed run) is
    // spent while the model still wanted to go on.
    state.finishReason = 'max-steps';
    return this.finishRun(options, state);
  }

  /**
   * Whether the loop takes another step for waiting input: after a step a
   * steer aborted (LOU-V10), or after a final reply with input queued during
   * it (LOU-V9). It does once the checkpoint holding that input is written.
   */
  private static async stepsOnForInput(
    options: ExecuteOptions,
    state: AgentRunState,
    outcome: string | ExecutionResult,
    maxSteps: number
  ): Promise<boolean> {
    const queued = outcome === 'stop' && Boolean(options.inputQueue?.messages.length) && state.steps < maxSteps;
    if (outcome !== 'steered' && !queued) return false;
    await state.saving;
    return true;
  }

  /** LOU-V9: appends the queued input to the transcript, for the model call of step `state.steps`. */
  private static applyQueuedInput(options: ExecuteOptions, state: AgentRunState): void {
    for (const queued of options.inputQueue?.take() ?? []) {
      state.messages.push(...queued.messages);
      runEventsOf(options)?.inputApplied(queued.id, state.steps);
    }
  }

  /** The run's end when it must stop before the next model call: aborted (LOU-V1) or over budget (LOU-V6). */
  private static stopBeforeStep(options: ExecuteOptions, state: AgentRunState): Promise<ExecutionResult> | undefined {
    if (options.signal?.aborted) return this.abortRun(options, state);
    const exceeded = state.budget?.check(state.usage, state.steps);
    return exceeded && this.stopForBudget(options, state, exceeded);
  }

  /**
   * LOU-V4: with `output`, parses and validates the final reply. When it is
   * invalid and `canRepair`, queues the issues for one more step ('repair');
   * otherwise ends the run as 'output-invalid'.
   */
  private static async checkOutput(
    options: ExecuteOptions,
    state: AgentRunState,
    canRepair: boolean
  ): Promise<'repair' | { object: unknown } | { outputError: OutputError } | undefined> {
    if (!options.output) return undefined;
    const checked = await validateOutput(options.output, state.finalText);
    if ('object' in checked) return checked;
    if (canRepair) {
      state.messages.push(outputRepairMessage(checked.outputError));
      return 'repair';
    }
    state.finishReason = 'output-invalid';
    return checked;
  }

  /**
   * Runs one step (runStep(), or the resumed pending tool calls of the
   * current step - LOU-U7/U9), bracketed by the stream's step events, with
   * a thrown error emitted as an `error` event and rethrown - unless the
   * run's signal was aborted, in which case the rejection is the abort
   * itself (e.g. the provider's AbortError) and the run ends as 'aborted'
   * instead (LOU-V1).
   */
  private static async runStepOrAbort<T extends string>(
    options: ExecuteOptions,
    state: AgentRunState,
    step: () => Promise<T | ExecutionResult>
  ): Promise<T | ExecutionResult> {
    const runEvents = runEventsOf(options);
    runEvents?.stepStart(state.steps);
    try {
      const outcome = await step();
      const finishReason = typeof outcome === 'string' ? undefined : outcome.finishReason;
      runEvents?.stepDone(state.steps, outcome === 'steered' ? 'steered' : finishReason);
      return outcome;
    } catch (error) {
      if (options.signal?.aborted) {
        runEvents?.stepDone(state.steps, 'aborted');
        return this.abortRun(options, state);
      }
      runEvents?.error(error);
      runEvents?.stepDone(state.steps, 'error');
      throw error;
    }
  }

  /**
   * One generate -> (tool calls) turn of the loop. Resolves to 'continue'
   * to take another step, 'stop' once the model replied without tool
   * calls, or the ExecutionResult to return early when a tool call paused
   * the run for approval.
   */
  private static async runStep(
    options: ExecuteOptions,
    state: AgentRunState,
    tools: ToolDefinition[],
    agentSpanId: string
  ): Promise<'continue' | 'stop' | 'steered' | ExecutionResult> {
    const generatedStep = await this.generateOrSurfaceError(options, state, tools, agentSpanId);
    if (!generatedStep || generatedStep === 'steered') {
      return generatedStep ?? 'continue';
    }
    const { generated, measured } = generatedStep;

    // A turn produced a real result - any pending "the last thing that
    // happened was a provider failure" tracking no longer applies.
    state.lastSurfacedProviderError = undefined;

    // Update usage (LOU-V5)
    const stepUsage = recordStep(state, measured);
    // N1a: the provider already ran its hosted calls; they are counted, never run here.
    countHostedCalls(state.usage, generated.hostedToolCalls);

    const text = await this.guardOutput(options, state, generated);
    if (typeof text !== 'string') return text;
    const result = { ...generated, text };
    noteReasoning(state, result.reasoning);

    // Handle text response
    if (result.text) {
      state.finalText = result.text;
      runEventsOf(options)?.textDone(result.text, stepUsage);
    }

    // Handle tool calls
    if (result.toolCalls && result.toolCalls.length > 0) {
      // LOU-V6: a budget spent by this call stops the run before its tools run.
      const exceeded = state.budget?.check(state.usage, state.steps, true);
      if (exceeded) {
        state.toolCalls.push(...result.toolCalls);
        state.messages.push(assistantTurn(result));
        pushAbortedBatchResults(state, result.toolCalls.map((toolCall) => ({ toolCall })), 'the run reached a budget limit');
        return this.stopForBudget(options, state, exceeded);
      }
      const paused = await this.runToolCalls(options, state, assistantTurn(result), result.toolCalls, agentSpanId);
      if (paused) {
        return paused;
      }

      // Continue loop for next generation
      state.finishReason = result.finishReason;
      return 'continue';
    }

    // No tool calls, we're done. Push the assistant's final reply onto
    // currentMessages so `result.messages` (the returned conversation
    // history) actually reflects it - previously this branch left
    // `finalText`/`result.text` set but never appended a corresponding
    // assistant message here (unlike the tool-call branch above, which
    // always pushes one), so any caller treating `result.messages` as
    // the authoritative conversation (e.g. to seed a follow-up turn)
    // silently lost the agent's own last reply whenever a turn ended
    // without a tool call - the common case for a plain chat exchange.
    if (result.text) {
      state.messages.push(withHostedCalls({ role: 'assistant', content: result.text }, result.hostedToolCalls));
    }
    state.finishReason = result.finishReason;
    return 'stop';
  }

  /**
   * LOU-X4: the step's text after the output guardrails (they check the final
   * reply, and every step's text when the run is iterated - a `stream()` -
   * before it is emitted), or the blocked run's result. `send()` / `execute()`
   * with listeners stream their model calls (M9) but are not iterated: only
   * the final reply is checked, as without listeners.
   */
  private static async guardOutput(
    options: ExecuteOptions,
    state: AgentRunState,
    { text, toolCalls }: GenerateResult
  ): Promise<string | ExecutionResult> {
    if (!text || (toolCalls?.length && !runEventsOf(options)?.iterated)) return text;
    const checked = await checkOutputGuardrails(options, text, state.messages);
    return 'tripped' in checked ? this.stopForGuardrail(options, state, checked.tripped) : checked.text;
  }

  /**
   * Calls provider.generate() for the next turn. Resolves to `undefined`
   * when the failure was instead folded into the conversation for the
   * model to react to (LOU-T4 `surfaceRetryableProviderErrors`), or
   * `'steered'` when `run.steer()` aborted the call before it emitted
   * anything (LOU-V10): its partial output is dropped.
   */
  private static async generateOrSurfaceError(
    options: ExecuteOptions,
    state: AgentRunState,
    tools: ToolDefinition[],
    agentSpanId: string
  ): Promise<GeneratedStep | 'steered' | undefined> {
    const callSignal = options.inputQueue?.startCall();
    try {
      const generateRequest = await prepareGenerateRequest(options, state.messages, tools, callSignal);
      callSignal?.throwIfAborted();
      const generated = await generateInSpan(options, generateRequest, state.messages, agentSpanId, callSignal);
      callSignal?.throwIfAborted();
      return generated;
    } catch (generateError) {
      if (callSignal?.aborted && !options.signal?.aborted) {
        return 'steered';
      }
      // A cancellation is not a provider failure - never compact it or fold
      // it into the conversation for a retry. With `signal` (LOU-V1) the
      // loop turns it into an 'aborted' result; an AbortError thrown without
      // one (see isAbortError()) reaches the caller untouched.
      if (options.signal?.aborted || isAbortError(generateError)) {
        throw generateError;
      }

      const { compacted, error: compactedError } = compactGenerateError(
        generateError,
        options.provider.name
      );

      if (!shouldSurfaceToModel(options, compacted)) {
        // Non-actionable category ('auth-failure', 'unknown'), or the
        // opt-in flag is off: reject execute() cleanly, exactly like
        // before LOU-T4 - just with the small compacted error instead of
        // the raw provider error. runAgentLoop()'s catch block emits the
        // 'error' event for this, same as it does for every other thrown
        // error in the loop - no need to duplicate that here.
        throw compactedError;
      }

      // See providerErrorMessage() for why this is a tagged `user` message.
      state.messages.push(providerErrorMessage(compacted));

      runEventsOf(options)?.error(compactedError);

      state.lastSurfacedProviderError = compactedError;
      return undefined;
    } finally {
      options.inputQueue?.endPhase();
    }
  }

  /**
   * Executes the tool calls of one assistant turn - concurrently up to
   * `toolConcurrency` (LOU-V3, see that option for the ordering contract) -
   * appending the results to the conversation in call order and
   * checkpointing as they are recorded. Resolves to the ExecutionResult to
   * return when the run pauses for approval or is aborted.
   */
  private static async runToolCalls(
    options: ExecuteOptions,
    state: AgentRunState,
    turn: Message,
    toolCalls: ToolCall[],
    agentSpanId: string
  ): Promise<ExecutionResult | undefined> {
    state.toolCalls.push(...toolCalls);

    // Add assistant message with tool calls (and LOU-V13: its signed reasoning)
    state.messages.push(turn);

    // LOU-U9: checkpoint the model's turn before any tool runs, so a crash
    // from here on resumes by running the calls - never by asking the
    // model again.
    await saveStepCheckpoint(options, state);

    return this.runBatch(options, state, toolCalls, agentSpanId);
  }

  /**
   * LOU-U7/U9: runs the tool calls of the last model turn that have no
   * result yet (left by a crash, or by an approval pause mid-batch), then
   * appends any input queued behind them. Resolves to 'continue', or the
   * ExecutionResult when the run pauses again or is aborted.
   */
  private static async runPendingToolCalls(
    options: ExecuteOptions,
    state: AgentRunState,
    agentSpanId: string
  ): Promise<'continue' | ExecutionResult> {
    const calls = state.pendingToolCalls;
    state.pendingToolCalls = [];
    const stopped = await this.runBatch(options, state, calls, agentSpanId);
    if (stopped) {
      return stopped;
    }
    state.messages.push(...state.queuedInput);
    state.queuedInput = [];
    return 'continue';
  }

  /**
   * Runs one batch of tool calls through the LOU-V3 scheduler, recording
   * results in call order and checkpointing as they are recorded.
   */
  private static async runBatch(
    options: ExecuteOptions,
    state: AgentRunState,
    toolCalls: ToolCall[],
    agentSpanId: string
  ): Promise<ExecutionResult | undefined> {
    const runEvents = runEventsOf(options);
    // LOU-Y1: tool calls whose sub-agent paused for approval, in call order.
    const suspensions: SubagentSuspension[] = [];
    const batch = await runToolBatch(
      toolCalls,
      options.toolConcurrency ?? 'unbounded',
      {
        start: (toolCall) => {
          runEvents?.toolStart(toolCall);
          return this.startToolCall(options, state, toolCall, agentSpanId);
        },
        onComplete: (toolResult) => runEvents?.toolSettled(toolResult),
        record: (toolCall, outcome) => {
          pushToolResult(state, toolCall, outcome);
          if (outcome.subagent) suspensions.push(outcome.subagent);
        },
        persist: () => saveStepCheckpoint(options, state),
      },
      // LOU-V10: a steer stops the batch from starting more calls; running ones finish.
      withSteerSignal(options.signal, options.inputQueue?.startBatch())
    );
    options.inputQueue?.endPhase();

    return this.settleToolBatch(options, state, batch, suspensions);
  }

  /**
   * Turns a finished batch into the run's next move: abort (finished calls
   * keep their results, the rest are cancelled), reject with the first
   * fatal error, pause for approval, or carry on (`undefined`).
   */
  private static settleToolBatch(
    options: ExecuteOptions,
    state: AgentRunState,
    batch: ToolBatchResult,
    suspensions: SubagentSuspension[]
  ): Promise<ExecutionResult> | undefined {
    if (options.signal?.aborted) {
      pushAbortedBatchResults(state, batch.unrecorded);
      return this.abortRun(options, state);
    }
    // LOU-X4: a tool guardrail blocked a call before it ran; the rest of the batch did not start.
    if (batch.failure?.error instanceof GuardrailError) {
      pushAbortedBatchResults(state, batch.unrecorded, 'a guardrail stopped the run');
      return this.stopForGuardrail(options, state, batch.failure.error.guardrail);
    }
    if (batch.failure) {
      throw batch.failure.error;
    }
    const suspension = settleSuspensions(state.messages, suspensions, Boolean(batch.approval));
    if (batch.approval) {
      const { toolCall, outcome } = batch.approval;
      const pausedAt = batch.unrecorded.findIndex((call) => call.toolCall === toolCall);
      const remaining = batch.unrecorded.slice(pausedAt + 1).map((call) => call.toolCall);
      return this.pauseForApproval(options, state, toolCall, outcome, remaining);
    }
    // LOU-V10: what is left of a batch a steer stopped was not run.
    pushAbortedBatchResults(state, batch.unrecorded, 'the user steered the run to new input');
    if (suspension) {
      return this.savePause(options, state, suspensionRecord(options, state, suspension));
    }
    return undefined;
  }

  /**
   * Starts one tool call. `gate` settles once it passed its pre-execution
   * checks (or rejects with the error that stopped it); `done` settles with
   * its outcome.
   */
  private static startToolCall(
    options: ExecuteOptions,
    state: AgentRunState,
    toolCall: ToolCall,
    agentSpanId: string
  ): StartedToolCall {
    let openGate!: (prepared: PreparedToolCall) => void;
    let failGate!: (error: unknown) => void;
    const gate = new Promise<PreparedToolCall>((resolve, reject) => {
      openGate = resolve;
      failGate = reject;
    });
    const done = this.runToolCallInSpan(options, state, toolCall, agentSpanId, openGate);
    // Rejecting an already-resolved gate is a no-op.
    done.catch(failGate);
    return { gate, done };
  }

  /**
   * Runs one tool call inside a `tool.call` span parented to the run's
   * `agent.run` span.
   */
  private static runToolCallInSpan(
    options: ExecuteOptions,
    state: AgentRunState,
    toolCall: ToolCall,
    agentSpanId: string,
    onPrepared?: (prepared: PreparedToolCall) => void
  ): Promise<ToolCallOutcome> {
    const {
      agent,
      toolRegistry,
      onToolCall,
      onToolResult,
      sandbox = NoopSandbox,
      hooks,
      sessionId,
      exporter,
      redactContent = false,
      signal,
    } = options;

    const init = toolSpanInit({ id: toolCall.id, name: toolCall.function.name }, { agent, toolRegistry, sessionId });
    return withSpan(
      exporter,
      init.name,
      init.attributes,
      async (toolSpan) => {
        const toolCallStart = Date.now();
        // LOU-Y1: a sub-agent started by this tool call inherits from this run.
        const scope: ToolCallScope = {
          runtime: options,
          toolCallId: toolCall.id,
          spanId: toolSpan.id,
          execute: (childOptions) => AgentExecutor.execute(childOptions),
        };
        const executed = await this.executeToolCall(
          toolCall,
          agent,
          toolRegistry,
          onToolCall,
          onToolResult,
          sandbox,
          hooks,
          sessionId,
          state.messages,
          signal,
          onPrepared,
          // LOU-V5: a delegated child's usage is added to this run's totals.
          (child) => mergeDelegatedUsage(state.usage, child),
          scope
        );
        const parsedArgs =
          executed.args === undefined
            ? parseToolArguments(toolCall, toolCall.function.arguments)
            : executed.args;
        recordToolOutcome(
          toolSpan,
          {
            args: parsedArgs,
            result: executed.result,
            error: executed.error,
            latencyMs: Date.now() - toolCallStart,
          },
          { redactContent, captureContent: resolveCaptureContent(options.captureContent) }
        );
        return executed;
      },
      agentSpanId,
      init.kind
    );
  }

  /**
   * Persists a pending approval (plus the snapshot resume.ts needs, with
   * the turn's not-yet-run calls - LOU-U7) and ends this execute() call
   * with an 'awaiting-approval' result. The checkpoint is marked
   * 'awaiting-approval' (LOU-U8) so new input cannot bypass the decision.
   */
  private static async pauseForApproval(
    options: ExecuteOptions,
    state: AgentRunState,
    toolCall: ToolCall,
    toolResult: ToolCallOutcome,
    remainingToolCalls: ToolCall[]
  ): Promise<ExecutionResult> {
    const { agent, approvalStore, sessionId, principal } = options;
    if (!approvalStore) {
      throw new ConfigurationError(
        `Tool '${toolResult.toolName}' requires approval but no approvalStore was provided to AgentExecutor.execute()`,
        'approvalStore',
        'LOUSHO_APPROVAL_STORE_MISSING'
      );
    }

    const pending: PendingApproval = {
      id: newId(),
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      args: toolResult.args || {},
      agentId: agent.id,
      createdAt: new Date().toISOString(),
      // N10b: whose call it is, for `approve` and channel `approvers`.
      ...(principal && { principal }),
    };
    const snapshot: ExecutionSnapshot = {
      // The agent as configured: resume re-applies skills and sub-agents.
      agent: baseAgentOf(agent),
      // Queued input rides at the end; resume moves it behind the results.
      currentMessages: [...state.messages, ...state.queuedInput],
      pendingToolCall: pending,
      steps: state.steps,
      sessionId,
      remainingToolCalls,
      usage: structuredClone(state.usage),
      // N10b: the resumed run acts for this caller, whoever decides.
      ...(principal && { principal }),
    };
    return this.savePause(options, state, { pending, snapshot });
  }

  /**
   * Saves an approval record and ends this execute() call with an
   * 'awaiting-approval' result. The checkpoint is marked
   * 'awaiting-approval' (LOU-U8) so new input cannot bypass the decision.
   */
  private static async savePause(
    options: ExecuteOptions,
    state: AgentRunState,
    { pending, snapshot }: { pending: PendingApproval; snapshot: ExecutionSnapshot }
  ): Promise<ExecutionResult> {
    const { approvalStore } = options;
    // Approval first: a crash between the two writes then leaves a
    // resumable 'in-progress' checkpoint, never one naming a lost approval.
    if (approvalStore) {
      snapshot.agentFingerprint ??= await ensureFingerprint(options, state);
      await approvalStore.save(pending, snapshot);
    }
    await saveStepCheckpoint(options, state, 'awaiting-approval', pending.id, describeApproval(pending).kind);
    runEventsOf(options)?.approvalRequested(pending);

    return {
      ...toExecutionResult(state, '', 'awaiting-approval'),
      approvalId: pending.id,
    };
  }

  /**
   * Ends a run whose signal was aborted (LOU-V1): checkpoints the state so
   * far (when checkpointing is on, so the session can be resumed later)
   * and resolves with finishReason 'aborted'.
   */
  private static async abortRun(
    options: ExecuteOptions,
    state: AgentRunState
  ): Promise<ExecutionResult> {
    const timedOut = budgetOfAbort(options.signal);
    if (timedOut) return this.stopForBudget(options, state, timedOut);
    state.finishReason = 'aborted';
    options.inputQueue?.close();
    await saveStepCheckpoint(options, state);

    return toExecutionResult(state, state.finalText, 'aborted');
  }

  /**
   * LOU-V6: ends a run whose budget tripped like `max-steps` (checkpointed
   * as finished), after a `budget.exceeded` event; throws
   * `BudgetExceededError` under `onExceeded: 'throw'`.
   */
  private static async stopForBudget(
    options: ExecuteOptions,
    state: AgentRunState,
    budget: BudgetExceeded
  ): Promise<ExecutionResult> {
    state.finishReason = 'budget-exceeded';
    runEventsOf(options)?.budgetExceeded(budget);
    if (state.budget?.mode(budget) === 'throw') {
      await saveStepCheckpoint(options, state, 'finished');
      throw new BudgetExceededError(budget);
    }
    return { ...(await this.finishRun(options, state)), budget };
  }

  /** LOU-X4: ends a blocked run like {@link stopForBudget}, after a `guardrail.tripped` event. */
  private static async stopForGuardrail(
    options: ExecuteOptions,
    state: AgentRunState,
    guardrail: GuardrailTrip
  ): Promise<ExecutionResult> {
    state.finishReason = 'guardrail';
    state.finalText = '';
    runEventsOf(options)?.guardrail({ type: 'guardrail.tripped', ...guardrail });
    if (options.guardrails?.onTripped === 'throw') {
      await saveStepCheckpoint(options, state, 'finished');
      throw new GuardrailError(guardrail);
    }
    return { ...(await this.finishRun(options, state)), guardrail };
  }

  /**
   * Ends a run that left the loop - the model stopped requesting tools,
   * or maxSteps was exhausted.
   */
  private static async finishRun(
    options: ExecuteOptions,
    state: AgentRunState,
    output?: Pick<ExecutionResult, 'object' | 'outputError'>
  ): Promise<ExecutionResult> {
    // LOU-T4: `maxSteps` was exhausted, but the very last thing that
    // happened was a surfaced-to-the-model provider failure (not a genuine
    // model stop/tool-calls turn) - every retry the model got a chance to
    // take failed the same way. Reject with that last compacted error
    // instead of silently returning a "successful-looking" ExecutionResult
    // (finishReason would otherwise read as a stale value from before the
    // failures started, misrepresenting what actually happened).
    if (state.lastSurfacedProviderError) {
      runEventsOf(options)?.error(state.lastSurfacedProviderError);
      throw state.lastSurfacedProviderError;
    }

    // The run has reached a terminal state (either the model stopped
    // requesting tools, or maxSteps was exhausted). LOU-U8: keep the
    // transcript, marked 'finished', so a later execute() call reusing this
    // sessionId continues the conversation with its new input instead of
    // resuming this run (or forgetting it).
    await saveStepCheckpoint(options, state, 'finished');

    return { ...toExecutionResult(state, state.finalText, state.finishReason), ...output };
  }

  /**
   * Execute a tool call (see toolCallExecution.ts). Kept as a positional,
   * static entry point the loop above calls into.
   */
  private static async executeToolCall(
    toolCall: ToolCall,
    agent: AgentConfig,
    toolRegistry?: ToolRegistry,
    onToolCall?: ExecuteOptions['onToolCall'],
    onToolResult?: ExecuteOptions['onToolResult'],
    sandbox: SandboxAdapter = NoopSandbox,
    hooks?: HookRegistry,
    sessionId?: string,
    messages: Message[] = [],
    signal?: AbortSignal,
    onPrepared?: (prepared: PreparedToolCall) => void,
    onDelegatedUsage?: ToolCallContext['onDelegatedUsage'],
    scope?: ToolCallScope
  ): Promise<ToolCallOutcome> {
    return runToolCall(
      toolCall,
      {
        agent,
        toolRegistry,
        onToolCall,
        onToolResult,
        sandbox,
        hooks,
        sessionId,
        // N10b: the run's principal (the scope's runtime is the run's options).
        principal: scope?.runtime.principal,
        messages,
        signal,
        onDelegatedUsage,
        scope,
      },
      onPrepared
    );
  }

  /**
   * Guards the options execute() truly cannot run without, throwing a
   * clear error naming the missing field plus a corrective one-line code
   * snippet - instead of the generic "Cannot read properties of
   * undefined" TypeError that would otherwise surface deep inside
   * runAgentLoop() (e.g. `provider.generate(...)` when `provider` is
   * undefined).
   */
  private static validateExecuteOptions(
    options: ExecuteOptions,
    caller = 'AgentExecutor.execute'
  ): void {
    if (!options || !options.provider) {
      throw new ConfigurationError(
        `${caller}: 'provider' is required. ` +
          "Example: AgentExecutor.execute({ agent, input, provider: myProvider })",
        'provider',
        'LOUSHO_CONFIG_MISSING_PROVIDER'
      );
    }
    if (!options.agent) {
      throw new ConfigurationError(
        `${caller}: 'agent' is required. ` +
          'Example: AgentExecutor.execute({ agent: AgentBuilder.create()...build(), input, provider })',
        'agent',
        'LOUSHO_CONFIG_MISSING_AGENT'
      );
    }
    if (options.input === undefined || options.input === null) {
      throw new ConfigurationError(
        `${caller}: 'input' is required. ` +
          "Example: AgentExecutor.execute({ agent, input: 'hello', provider })",
        'input',
        'LOUSHO_CONFIG_MISSING_INPUT'
      );
    }
    assertToolConcurrency(options.toolConcurrency, caller);
    assertMaxSubagentDepth(options.maxSubagentDepth, caller);
  }
}
