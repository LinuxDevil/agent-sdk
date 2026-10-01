/**
 * Agent Executor
 * Executes agents with streaming support and tool calling
 */

import type { Skill } from '../skills/defineSkill';
import { withSkills } from '../skills/withSkills';
import { nanoid } from 'nanoid';
import { LLMProvider, Message, ToolCall, GenerateOptions, GenerateResult, ToolDefinition } from '../providers';
import { AgentConfig } from '../types';
import { ToolRegistry } from '../tools';
import { SandboxAdapter, NoopSandbox } from '../security/sandboxCore';
import { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import { CheckpointStore } from './checkpoint';
import { TraceExporter, withSpan } from './tracing';
import {
  agentRunSpanInit,
  recordToolOutcome,
  resolveCaptureContent,
  toolSpanInit,
} from './genAiSpans';
import { HookRegistry } from './hooks';
import { isAbortError } from './errors';
import {
  PreparedToolCall,
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
  generateInSpan,
  prepareGenerateRequest,
  providerErrorMessage,
  shouldSurfaceToModel,
} from './generateStep';
import {
  AgentRunState,
  addUsage,
  loadRunState,
  pushAbortedBatchResults,
  pushToolResult,
  saveStepCheckpoint,
  toExecutionResult,
} from './agentRunState';

export { PropagatingToolError } from './propagatingToolError';

/**
 * Execution event types
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
 */
export type ExecutionFinishReason =
  | GenerateResult['finishReason']
  | 'awaiting-approval'
  | 'aborted'
  | (string & {});

/**
 * Execution event
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
    result: any;
    error?: string;
  };
  finishReason?: ExecutionFinishReason;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  error?: Error;
  /**
   * On an `abort` event: the `reason` of the aborted signal (a
   * `DOMException` named `AbortError` unless the caller passed their own
   * reason to `controller.abort(reason)`).
   */
  abortReason?: unknown;
}

/**
 * Execution options
 */
export interface ExecuteOptions {
  agent: AgentConfig;
  input: string | Message[];
  provider: LLMProvider;
  toolRegistry?: ToolRegistry;
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
  streaming?: boolean;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  onEvent?: (event: ExecutionEvent) => void;
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
   * with the elapsed wall-clock time in milliseconds.
   */
  onLLMResponse?: (response: GenerateResult, latencyMs: number) => void | Promise<void>;
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
}

/**
 * Execution result
 */
export interface ExecutionResult {
  text: string;
  messages: Message[];
  toolCalls: ToolCall[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: ExecutionFinishReason;
  steps: number;
  approvalId?: string;
}

/**
 * Agent Executor
 */
export class AgentExecutor {
  /**
   * Execute agent without streaming
   */
  static async execute(options: ExecuteOptions): Promise<ExecutionResult> {
    // AgentExecutor is a static, instance-free API - there is no
    // constructor to guard these, so execute() is the first and only
    // entry point where a missing required option can be caught before it
    // fails deep inside runAgentLoop() with a generic "Cannot read
    // properties of undefined" error (e.g. `provider.generate(...)`
    // throwing because `provider` was never checked).
    this.validateExecuteOptions(options);

    const { input, exporter } = options;

    // The entire run is wrapped in a top-level 'agent.run' span (LOU-E5).
    // AgentExecutor is a static-function API (no `this` instance to hang a
    // span/exporter off of), so the original execute() body below just
    // moves, unchanged in behavior, into this withSpan() callback; the
    // callback receives its own span (`agentSpan`) whose generated `id` is
    // then threaded as `parentId` into the nested 'llm.generate' and
    // 'tool.call' withSpan() calls, giving the 3-level span tree its
    // parent/child relationships without any instance state.
    const init = agentRunSpanInit(
      { ...options, input },
      resolveCaptureContent(options.captureContent)
    );
    return withSpan(
      exporter,
      init.name,
      init.attributes,
      async (agentSpan) =>
        this.runAgentLoop(
          { ...options, ...withSkills(options.agent, options.toolRegistry, options.skills) },
          agentSpan.id
        ),
      undefined,
      init.kind
    );
  }

  /**
   * The actual execution loop, split out of execute() so the top-level
   * 'agent.run' span (LOU-E5) can wrap it via withSpan() while still
   * exposing execute() as the same static, instance-free entry point.
   */
  private static async runAgentLoop(
    options: ExecuteOptions,
    agentSpanId: string
  ): Promise<ExecutionResult> {
    const { agent, toolRegistry, maxSteps = 10, onEvent, signal } = options;

    // Emit start event
    this.emitEvent(onEvent, {
      type: 'start',
      timestamp: new Date(),
      agentId: agent.id,
      agentName: agent.name,
    });

    // Build tools
    const tools = buildTools(agent, toolRegistry);

    const state = await loadRunState(options);

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

    // Execution loop with tool calling. LOU-V1: the signal is checked
    // before every model call (here) and every tool call (runToolCalls()).
    while (state.steps < maxSteps) {
      if (signal?.aborted) {
        return this.abortRun(options, state);
      }
      state.steps++;

      const outcome = await this.runStepOrAbort(options, state, () =>
        this.runStep(options, state, tools, agentSpanId)
      );
      if (outcome === 'stop') {
        return this.finishRun(options, state);
      }
      if (outcome !== 'continue') {
        return outcome;
      }
    }

    return signal?.aborted ? this.abortRun(options, state) : this.finishRun(options, state);
  }

  /**
   * Runs one step (runStep(), or the resumed pending tool calls), with a
   * thrown error emitted as an `error` event and rethrown - unless the
   * run's signal was aborted, in which case the rejection is the abort
   * itself (e.g. the provider's AbortError) and the run ends as 'aborted'
   * instead (LOU-V1).
   */
  private static async runStepOrAbort<T>(
    options: ExecuteOptions,
    state: AgentRunState,
    step: () => Promise<T>
  ): Promise<T | ExecutionResult> {
    try {
      return await step();
    } catch (error) {
      if (options.signal?.aborted) {
        return this.abortRun(options, state);
      }
      this.emitEvent(options.onEvent, {
        type: 'error',
        timestamp: new Date(),
        error: error as Error,
      });
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
  ): Promise<'continue' | 'stop' | ExecutionResult> {
    const result = await this.generateOrSurfaceError(options, state, tools, agentSpanId);
    if (!result) {
      return 'continue';
    }

    // A turn produced a real result - any pending "the last thing that
    // happened was a provider failure" tracking no longer applies.
    state.lastSurfacedProviderError = undefined;

    // Update usage
    addUsage(state.usage, result.usage);

    // Handle text response
    if (result.text) {
      state.finalText = result.text;
      this.emitEvent(options.onEvent, {
        type: 'text-complete',
        timestamp: new Date(),
        text: result.text,
      });
    }

    // Handle tool calls
    if (result.toolCalls && result.toolCalls.length > 0) {
      const paused = await this.runToolCalls(options, state, result.text, result.toolCalls, agentSpanId);
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
      state.messages.push({
        role: 'assistant',
        content: result.text,
      });
    }
    state.finishReason = result.finishReason;
    return 'stop';
  }

  /**
   * Calls provider.generate() for the next turn. Resolves to `undefined`
   * when the failure was instead folded into the conversation for the
   * model to react to (LOU-T4 `surfaceRetryableProviderErrors`).
   */
  private static async generateOrSurfaceError(
    options: ExecuteOptions,
    state: AgentRunState,
    tools: ToolDefinition[],
    agentSpanId: string
  ): Promise<GenerateResult | undefined> {
    const generateRequest = await prepareGenerateRequest(options, state.messages, tools);

    try {
      return await generateInSpan(options, generateRequest, state.messages, agentSpanId);
    } catch (generateError) {
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

      this.emitEvent(options.onEvent, {
        type: 'error',
        timestamp: new Date(),
        error: compactedError,
      });

      state.lastSurfacedProviderError = compactedError;
      return undefined;
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
    assistantText: string | undefined,
    toolCalls: ToolCall[],
    agentSpanId: string
  ): Promise<ExecutionResult | undefined> {
    state.toolCalls.push(...toolCalls);

    // Add assistant message with tool calls
    state.messages.push({
      role: 'assistant',
      content: assistantText || '',
      toolCalls,
    });

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
    const { onEvent } = options;
    const batch = await runToolBatch(
      toolCalls,
      options.toolConcurrency ?? 'unbounded',
      {
        start: (toolCall) => {
          this.emitEvent(onEvent, { type: 'tool-call', timestamp: new Date(), toolCall });
          return this.startToolCall(options, state, toolCall, agentSpanId);
        },
        onComplete: (toolResult) =>
          this.emitEvent(onEvent, { type: 'tool-result', timestamp: new Date(), toolResult }),
        record: (toolCall, outcome) => pushToolResult(state, toolCall, outcome),
        persist: () => saveStepCheckpoint(options, state),
      },
      options.signal
    );

    return this.settleToolBatch(options, state, batch);
  }

  /**
   * Turns a finished batch into the run's next move: abort (finished calls
   * keep their results, the rest are cancelled), reject with the first
   * fatal error, pause for approval, or carry on (`undefined`).
   */
  private static settleToolBatch(
    options: ExecuteOptions,
    state: AgentRunState,
    batch: ToolBatchResult
  ): Promise<ExecutionResult> | undefined {
    if (options.signal?.aborted) {
      pushAbortedBatchResults(state, batch.unrecorded);
      return this.abortRun(options, state);
    }
    if (batch.failure) {
      throw batch.failure.error;
    }
    if (batch.approval) {
      const { toolCall, outcome } = batch.approval;
      const pausedAt = batch.unrecorded.findIndex((call) => call.toolCall === toolCall);
      const remaining = batch.unrecorded.slice(pausedAt + 1).map((call) => call.toolCall);
      return this.pauseForApproval(options, state, toolCall, outcome, remaining);
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
          onPrepared
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
    const { agent, approvalStore, sessionId, onEvent } = options;
    if (!approvalStore) {
      throw new Error(
        `Tool '${toolResult.toolName}' requires approval but no approvalStore was provided to AgentExecutor.execute()`
      );
    }

    const pending: PendingApproval = {
      id: nanoid(),
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      args: toolResult.args || {},
      agentId: agent.id,
      createdAt: new Date().toISOString(),
    };
    const snapshot: ExecutionSnapshot = {
      agent,
      // Queued input rides at the end; resume moves it behind the results.
      currentMessages: [...state.messages, ...state.queuedInput],
      pendingToolCall: pending,
      steps: state.steps,
      sessionId,
      remainingToolCalls,
    };

    // Approval first: a crash between the two writes then leaves a
    // resumable 'in-progress' checkpoint, never one naming a lost approval.
    await approvalStore.save(pending, snapshot);
    await saveStepCheckpoint(options, state, 'awaiting-approval', pending.id);

    this.emitEvent(onEvent, {
      type: 'finish',
      timestamp: new Date(),
      finishReason: 'awaiting-approval',
      usage: state.usage,
    });

    return {
      ...toExecutionResult(state, '', 'awaiting-approval'),
      approvalId: pending.id,
    };
  }

  /**
   * Ends a run whose signal was aborted (LOU-V1): checkpoints the state so
   * far (when checkpointing is on, so the session can be resumed later),
   * emits `abort` then `finish`, and resolves with finishReason 'aborted'.
   */
  private static async abortRun(
    options: ExecuteOptions,
    state: AgentRunState
  ): Promise<ExecutionResult> {
    const { onEvent, signal } = options;
    state.finishReason = 'aborted';
    await saveStepCheckpoint(options, state);

    this.emitEvent(onEvent, {
      type: 'abort',
      timestamp: new Date(),
      abortReason: signal?.reason,
      usage: state.usage,
    });
    this.emitEvent(onEvent, {
      type: 'finish',
      timestamp: new Date(),
      finishReason: 'aborted',
      usage: state.usage,
    });

    return toExecutionResult(state, state.finalText, 'aborted');
  }

  /**
   * Ends a run that left the loop - the model stopped requesting tools,
   * or maxSteps was exhausted.
   */
  private static async finishRun(
    options: ExecuteOptions,
    state: AgentRunState
  ): Promise<ExecutionResult> {
    const { onEvent } = options;

    // LOU-T4: `maxSteps` was exhausted, but the very last thing that
    // happened was a surfaced-to-the-model provider failure (not a genuine
    // model stop/tool-calls turn) - every retry the model got a chance to
    // take failed the same way. Reject with that last compacted error
    // instead of silently returning a "successful-looking" ExecutionResult
    // (finishReason would otherwise read as a stale value from before the
    // failures started, misrepresenting what actually happened).
    if (state.lastSurfacedProviderError) {
      this.emitEvent(onEvent, {
        type: 'error',
        timestamp: new Date(),
        error: state.lastSurfacedProviderError,
      });
      throw state.lastSurfacedProviderError;
    }

    // Emit finish event
    this.emitEvent(onEvent, {
      type: 'finish',
      timestamp: new Date(),
      finishReason: state.finishReason,
      usage: state.usage,
    });

    // The run has reached a terminal state (either the model stopped
    // requesting tools, or maxSteps was exhausted). LOU-U8: keep the
    // transcript, marked 'finished', so a later execute() call reusing this
    // sessionId continues the conversation with its new input instead of
    // resuming this run (or forgetting it).
    await saveStepCheckpoint(options, state, 'finished');

    return toExecutionResult(state, state.finalText, state.finishReason);
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
    onPrepared?: (prepared: PreparedToolCall) => void
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
        messages,
        signal,
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
  private static validateExecuteOptions(options: ExecuteOptions): void {
    if (!options || !options.provider) {
      throw new Error(
        "AgentExecutor.execute: 'provider' is required. " +
          "Example: AgentExecutor.execute({ agent, input, provider: myProvider })"
      );
    }
    if (!options.agent) {
      throw new Error(
        "AgentExecutor.execute: 'agent' is required. " +
          'Example: AgentExecutor.execute({ agent: AgentBuilder.create()...build(), input, provider })'
      );
    }
    if (options.input === undefined || options.input === null) {
      throw new Error(
        "AgentExecutor.execute: 'input' is required. " +
          "Example: AgentExecutor.execute({ agent, input: 'hello', provider })"
      );
    }
    assertToolConcurrency(options.toolConcurrency, 'AgentExecutor.execute');
  }

  /**
   * Emit event to callback
   */
  private static emitEvent(
    callback: ((event: ExecutionEvent) => void) | undefined,
    event: ExecutionEvent
  ): void {
    if (callback) {
      callback(event);
    }
  }
}
