/**
 * Agent Executor
 * Executes agents with streaming support and tool calling
 */

import { nanoid } from 'nanoid';
import { LLMProvider, Message, ToolCall, GenerateOptions, GenerateResult } from '../providers';
import { AgentConfig } from '../types';
import { ToolRegistry } from '../tools';
import { SandboxAdapter, NoopSandbox } from '../security/sandboxCore';
import { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import { Checkpoint, CheckpointStore } from './checkpoint';
import { TraceExporter, withSpan } from './tracing';
import { executeToolWithSandboxGuard } from './sandboxGuard';
import { HookRegistry } from './hooks';
import {
  CompactedLLMProviderError,
  compactProviderError,
  isModelActionableProviderErrorCategory,
} from './errors';

/**
 * Base class for tool errors that must NOT be swallowed by
 * executeToolCall()'s catch-all and converted into a conversational
 * `{error: ...}` tool-result message fed back to the LLM. Instead they
 * should propagate up out of execute() as a rejected promise, terminating
 * the run and giving the caller (which may itself be a parent delegate
 * tool's execute(), see DelegationTool.ts) an unambiguous signal.
 *
 * DelegationTool.ts's DelegationDepthExceededError extends this so that a
 * runaway delegation cycle (A -> B -> A -> ...) is stopped dead the moment
 * any one level's maxDepth guard fires, rather than having that error
 * re-enter the conversation as tool output that prompts the LLM to retry
 * the delegation - which is what let the original bug grow unbounded
 * (O(maxSteps^maxDepth) LLM calls) instead of failing fast.
 *
 * This lives here (not in DelegationTool.ts) because DelegationTool.ts
 * already imports AgentExecutor from this file; having AgentExecutor.ts
 * import back from DelegationTool.ts would be a circular import. Defining
 * the shared marker in this lower-level file lets both directions work
 * without a cycle.
 */
export class PropagatingToolError extends Error {}

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
  | 'error';

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
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  error?: Error;
}

/**
 * Execution options
 */
export interface ExecuteOptions {
  agent: AgentConfig;
  input: string | Message[];
  provider: LLMProvider;
  toolRegistry?: ToolRegistry;
  streaming?: boolean;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  onEvent?: (event: ExecutionEvent) => void;
  approvalStore?: ApprovalStore;
  sessionId?: string;
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
   * in a 3-level span tree: a top-level `agent.run` span, with a nested
   * `llm.generate` span around each provider.generate() call and a nested
   * `tool.call` span around each tool execution, both parented to
   * `agent.run` via Span.parentId. Omitted (or no exporter) means
   * withSpan() is a no-op wrapper - execute()'s behavior is unchanged.
   */
  exporter?: TraceExporter;
  /**
   * When true, span attributes omit potentially sensitive content (the
   * `agent.run` input isn't captured differently, but `llm.generate`
   * leaves out `prompt` and `tool.call` leaves out `args`/`result`).
   * Token counts, finish reason, tool name and error/latency are never
   * redacted. Defaults to false.
   */
  redactContent?: boolean;
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
   *   prefix in runAgentLoop()) and the loop retries generation, consuming
   *   one `maxSteps` step exactly like any other turn. THIS part is
   *   opt-in-only because it is a genuine behavior change for those three
   *   categories: today they always reject; with this flag set, a
   *   persistently-failing provider call instead keeps consuming steps
   *   until either it succeeds, a non-actionable failure occurs, or
   *   `maxSteps` is exhausted (at which point `execute()` still rejects
   *   with the last compacted error - see runAgentLoop() - rather than
   *   silently returning a hollow "successful" result).
   */
  surfaceRetryableProviderErrors?: boolean;
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
  finishReason: string;
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
    return withSpan(
      exporter,
      'agent.run',
      { input: typeof input === 'string' ? input : JSON.stringify(input) },
      async (agentSpan) => this.runAgentLoop(options, agentSpan.id),
      undefined
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
    const {
      agent,
      input,
      provider,
      toolRegistry,
      maxSteps = 10,
      temperature,
      maxTokens,
      onEvent,
      approvalStore,
      sessionId,
      checkpointStore,
      skipSystemPromptInjection,
      initialSteps,
      onLLMRequest,
      onLLMResponse,
      onToolCall,
      onToolResult,
      exporter,
      redactContent = false,
      sandbox = NoopSandbox,
      hooks,
      businessState,
      surfaceRetryableProviderErrors = false,
    } = options;

    // Emit start event
    this.emitEvent(onEvent, {
      type: 'start',
      timestamp: new Date(),
      agentId: agent.id,
      agentName: agent.name,
    });

    // Build tools
    const tools = this.buildTools(agent, toolRegistry);

    // If a checkpoint exists for this sessionId, rehydrate state from it
    // instead of building messages from scratch.
    let checkpoint: Checkpoint | null = null;
    if (sessionId && checkpointStore) {
      checkpoint = await checkpointStore.load(sessionId);
    }

    let currentMessages: Message[];
    let allToolCalls: ToolCall[];
    let totalUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
    let steps: number;

    // LOU-T1: on a rehydrated run (e.g. a fresh process resuming after a
    // crash), the caller of this execute() call may have no way to know
    // what businessState a *previous* process attached - that's exactly
    // the "second store, hope it stays aligned" gap this field closes. So
    // when a checkpoint is loaded and this call's own `businessState`
    // option was left unset, fall back to the value already stored on the
    // checkpoint rather than silently dropping it. An explicit
    // `businessState` passed to *this* call always wins (e.g. a caller
    // deliberately updating it as part of the resumed run).
    let effectiveBusinessState = businessState;

    if (checkpoint) {
      currentMessages = [...checkpoint.messages];
      allToolCalls = [...(checkpoint.toolCalls as ToolCall[])];
      totalUsage = { ...checkpoint.usage };
      steps = checkpoint.stepIndex;
      if (effectiveBusinessState === undefined) {
        effectiveBusinessState = checkpoint.businessState;
      }
    } else {
      // Build messages from scratch (fallback path)
      const messages = this.buildMessages(agent, input, skipSystemPromptInjection);
      currentMessages = [...messages];
      allToolCalls = [];
      totalUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      steps = initialSteps ?? 0;
    }

    let finalText = '';
    let finishReason = 'stop';
    // LOU-T4: set right before a compacted, model-actionable provider error
    // is pushed onto `messages` and the loop retries; cleared on any turn
    // that actually produces a result (text or tool calls). If the loop
    // exits because `maxSteps` was exhausted while this is still set, the
    // very last thing that happened was a provider failure, not a genuine
    // stop/tool-calls turn - see the post-loop check below for why
    // `execute()` still rejects in that case instead of returning a hollow
    // "successful" result whose `finishReason` would otherwise misleadingly
    // read as if the model actually gave up on its own.
    let lastSurfacedProviderError: CompactedLLMProviderError | undefined;

    // Execution loop with tool calling
    while (steps < maxSteps) {
      steps++;

      try {
        const generateRequest: GenerateOptions = {
          model: agent.settings?.model || 'gpt-4',
          messages: currentMessages,
          temperature,
          maxTokens,
          tools: tools.length > 0 ? tools : undefined,
        };

        if (onLLMRequest) {
          await onLLMRequest(generateRequest);
        }

        if (hooks) {
          await hooks.runPreGenerate({
            agentId: agent.id,
            agentName: agent.name,
            sessionId,
            messages: currentMessages,
            request: generateRequest,
          });
        }

        let result: GenerateResult;
        try {
          result = await withSpan(
            exporter,
            'llm.generate',
            {
              model: generateRequest.model,
              ...(redactContent ? {} : { prompt: JSON.stringify(generateRequest.messages) }),
            },
            async (llmSpan) => {
              const llmStart = Date.now();
              const generated = await provider.generate(generateRequest);
              const llmLatencyMs = Date.now() - llmStart;

              // Token counts and finish reason are never redacted.
              llmSpan.attributes = {
                ...llmSpan.attributes,
                promptTokens: generated.usage.promptTokens,
                completionTokens: generated.usage.completionTokens,
                totalTokens: generated.usage.totalTokens,
                finishReason: generated.finishReason,
              };

              if (onLLMResponse) {
                await onLLMResponse(generated, llmLatencyMs);
              }

              if (hooks) {
                await hooks.runPostGenerate(
                  {
                    agentId: agent.id,
                    agentName: agent.name,
                    sessionId,
                    messages: currentMessages,
                    request: generateRequest,
                  },
                  generated
                );
              }

              return generated;
            },
            agentSpanId
          );
        } catch (generateError) {
          // LOU-T4 (Factor 9): compact whatever the provider adapter threw
          // - a raw 'ai'-SDK APICallError/LoadAPIKeyError/RetryError, or a
          // bare network error - into a small CompactedProviderError before
          // it goes anywhere near the caller or `messages`. See errors.ts's
          // `compactProviderError()` doc comment for the full mapping
          // evidence (all four adapters share the same 'ai'-SDK error
          // taxonomy).
          const compacted = compactProviderError(generateError, provider.name);
          const compactedError = new CompactedLLMProviderError(
            compacted,
            generateError as Error
          );

          if (
            surfaceRetryableProviderErrors &&
            isModelActionableProviderErrorCategory(compacted.category)
          ) {
            // Fold the compacted error into the conversation so the MODEL
            // sees it on its next turn and can react (back off, shorten its
            // own ask, etc.) - this is what Factor 9 actually asks for
            // ("compact errors into the CONTEXT WINDOW"), for the
            // categories where handing it to the model is productive.
            //
            // This is pushed as a `role: 'user'` message, not `role:
            // 'tool'`, despite using the same `{error: ...}` shape the
            // tool-error compaction pattern uses: a `tool` message is only
            // valid, for every provider here, when it's paired with a
            // `toolCallId` from an assistant tool-call turn that actually
            // happened - and a provider.generate() failure means no such
            // assistant turn exists yet. Sending an orphaned `tool` message
            // would itself be rejected by the next generate() call (OpenAI/
            // Anthropic both require tool results to follow a matching
            // tool-call), compounding the failure instead of compacting it.
            // The `[provider-error]` prefix keeps this distinguishable from
            // genuine human input in transcripts/logs.
            currentMessages.push({
              role: 'user',
              content: `[provider-error] ${JSON.stringify({
                error: compacted.error,
                category: compacted.category,
                retryable: compacted.retryable,
                ...(compacted.retryAfterMs !== undefined
                  ? { retryAfterMs: compacted.retryAfterMs }
                  : {}),
              })}`,
            });

            this.emitEvent(onEvent, {
              type: 'error',
              timestamp: new Date(),
              error: compactedError,
            });

            lastSurfacedProviderError = compactedError;
            continue;
          }

          // Non-actionable category ('auth-failure', 'unknown'), or the
          // opt-in flag is off: reject execute() cleanly, exactly like
          // before LOU-T4 - just with the small compacted error instead of
          // the raw provider error. The outer catch block (below) emits the
          // 'error' event for this, same as it does for every other thrown
          // error in this loop - no need to duplicate that here.
          throw compactedError;
        }

        // A turn produced a real result - any pending "the last thing that
        // happened was a provider failure" tracking no longer applies.
        lastSurfacedProviderError = undefined;

        // Update usage
        totalUsage.promptTokens += result.usage.promptTokens;
        totalUsage.completionTokens += result.usage.completionTokens;
        totalUsage.totalTokens += result.usage.totalTokens;

        // Handle text response
        if (result.text) {
          finalText = result.text;
          this.emitEvent(onEvent, {
            type: 'text-complete',
            timestamp: new Date(),
            text: result.text,
          });
        }

        // Handle tool calls
        if (result.toolCalls && result.toolCalls.length > 0) {
          allToolCalls.push(...result.toolCalls);

          // Add assistant message with tool calls
          currentMessages.push({
            role: 'assistant',
            content: result.text || '',
            toolCalls: result.toolCalls,
          });

          // Execute tools and add results
          for (const toolCall of result.toolCalls) {
            this.emitEvent(onEvent, {
              type: 'tool-call',
              timestamp: new Date(),
              toolCall,
            });

            const toolResult = await withSpan(
              exporter,
              'tool.call',
              { toolName: toolCall.function.name },
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
                  currentMessages
                );
                let parsedArgs: unknown = executed.args;
                if (parsedArgs === undefined) {
                  try {
                    parsedArgs = JSON.parse(toolCall.function.arguments);
                  } catch {
                    parsedArgs = toolCall.function.arguments;
                  }
                }
                toolSpan.attributes = {
                  ...toolSpan.attributes,
                  ...(redactContent ? {} : { args: parsedArgs, result: executed.result }),
                  error: !!executed.error,
                  latencyMs: Date.now() - toolCallStart,
                };
                return executed;
              },
              agentSpanId
            );

            if (toolResult.requiresApproval) {
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
                currentMessages,
                pendingToolCall: pending,
                steps,
                sessionId,
              };

              await approvalStore.save(pending, snapshot);

              this.emitEvent(onEvent, {
                type: 'finish',
                timestamp: new Date(),
                finishReason: 'awaiting-approval',
                usage: totalUsage,
              });

              return {
                text: '',
                messages: currentMessages,
                toolCalls: allToolCalls,
                usage: totalUsage,
                finishReason: 'awaiting-approval',
                steps,
                approvalId: pending.id,
              };
            }

            this.emitEvent(onEvent, {
              type: 'tool-result',
              timestamp: new Date(),
              toolResult,
            });

            currentMessages.push({
              role: 'tool',
              content: JSON.stringify(toolResult.result),
              name: toolCall.function.name,
              toolCallId: toolCall.id,
              toolName: toolCall.function.name,
            });

            if (sessionId && checkpointStore) {
              const checkpoint: Checkpoint = {
                agentId: agent.id || '',
                sessionId,
                stepIndex: steps,
                messages: [...currentMessages],
                toolCalls: [...allToolCalls],
                usage: totalUsage,
                finishReason,
                businessState: effectiveBusinessState,
              };
              await checkpointStore.save(sessionId, checkpoint);
            }
          }

          // Continue loop for next generation
          finishReason = result.finishReason;
          continue;
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
          currentMessages.push({
            role: 'assistant',
            content: result.text,
          });
        }
        finishReason = result.finishReason;
        break;
      } catch (error) {
        this.emitEvent(onEvent, {
          type: 'error',
          timestamp: new Date(),
          error: error as Error,
        });
        throw error;
      }
    }

    // LOU-T4: `maxSteps` was exhausted, but the very last thing that
    // happened was a surfaced-to-the-model provider failure (not a genuine
    // model stop/tool-calls turn) - every retry the model got a chance to
    // take failed the same way. Reject with that last compacted error
    // instead of silently returning a "successful-looking" ExecutionResult
    // (finishReason would otherwise read as a stale value from before the
    // failures started, misrepresenting what actually happened).
    if (lastSurfacedProviderError) {
      this.emitEvent(onEvent, {
        type: 'error',
        timestamp: new Date(),
        error: lastSurfacedProviderError,
      });
      throw lastSurfacedProviderError;
    }

    // Emit finish event
    this.emitEvent(onEvent, {
      type: 'finish',
      timestamp: new Date(),
      finishReason,
      usage: totalUsage,
    });

    // The run has reached a terminal state (either the model stopped
    // requesting tools, or maxSteps was exhausted) - as opposed to the
    // 'awaiting-approval' early-return above, which is a mid-flight pause
    // where the checkpoint must stay in place so it can still be resumed.
    // Clear the checkpoint here so a later execute() call reusing this
    // sessionId builds fresh messages from its own `input` instead of
    // silently resuming from this now-finished run.
    if (sessionId && checkpointStore) {
      await checkpointStore.delete(sessionId);
    }

    return {
      text: finalText,
      messages: currentMessages,
      toolCalls: allToolCalls,
      usage: totalUsage,
      finishReason,
      steps,
    };
  }

  /**
   * Build messages from input
   */
  private static buildMessages(
    agent: AgentConfig,
    input: string | Message[],
    skipSystemPromptInjection = false
  ): Message[] {
    const messages: Message[] = [];

    // Add system prompt, unless the caller has indicated `input` already
    // includes one (e.g. resume.ts rebuilding from an ExecutionSnapshot).
    if (agent.prompt && !skipSystemPromptInjection) {
      messages.push({
        role: 'system',
        content: agent.prompt,
      });
    }

    // Add input messages
    if (typeof input === 'string') {
      messages.push({
        role: 'user',
        content: input,
      });
    } else {
      messages.push(...input);
    }

    return messages;
  }

  /**
   * Build tools from agent and registry
   */
  private static buildTools(
    agent: AgentConfig,
    toolRegistry?: ToolRegistry
  ): any[] {
    if (!agent.tools || !toolRegistry) {
      return [];
    }

    const tools: any[] = [];

    for (const [toolName, toolConfig] of Object.entries(agent.tools)) {
      const toolDesc = toolRegistry.get(toolName);
      if (toolDesc && toolDesc.tool) {
        // The tool from 'ai' SDK already has description and parameters
        tools.push({
          type: 'function',
          function: {
            name: toolName,
            description: toolDesc.tool.description || toolConfig.description || '',
            parameters: toolDesc.tool.parameters || {},
          },
        });
      }
    }

    return tools;
  }

  /**
   * Execute a tool call
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
    messages: Message[] = []
  ): Promise<{
    toolCallId: string;
    toolName: string;
    result: any;
    error?: string;
    requiresApproval?: boolean;
    args?: Record<string, unknown>;
  }> {
    if (onToolCall) {
      await onToolCall(toolCall);
    }

    // Parse args up front (best-effort) so hooks get a real object to
    // inspect/mutate even before doExecuteToolCall() parses them again for
    // its own use (needsApproval/execute). A hook mutating this object has
    // no effect on the actual call in this fallback case; see the
    // `hooks.runPreToolCall` call below for the real, load-bearing parse.
    let hookArgs: Record<string, unknown> = {};
    try {
      hookArgs = JSON.parse(toolCall.function.arguments);
    } catch {
      hookArgs = {};
    }

    if (hooks) {
      await hooks.runPreToolCall({
        agentId: agent.id,
        agentName: agent.name,
        sessionId,
        messages,
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        args: hookArgs,
        toolCall,
      });
    }

    const toolStart = Date.now();
    let outcome:
      | {
          toolCallId: string;
          toolName: string;
          result: any;
          error?: string;
          requiresApproval?: boolean;
          args?: Record<string, unknown>;
        }
      | undefined;
    let thrown: unknown;

    try {
      outcome = await this.doExecuteToolCall(toolCall, toolRegistry, sandbox, hookArgs);
      if (hooks) {
        await hooks.runPostToolCall(
          {
            agentId: agent.id,
            agentName: agent.name,
            sessionId,
            messages,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            args: hookArgs,
            toolCall,
          },
          {
            result: outcome.result,
            error: outcome.error,
            requiresApproval: outcome.requiresApproval,
          }
        );
      }
      return outcome;
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const latencyMs = Date.now() - toolStart;
      if (onToolResult) {
        await onToolResult(toolCall, outcome, latencyMs, thrown);
      }
    }
  }

  /**
   * Actual tool-execution logic, split out from executeToolCall() so the
   * onToolCall/onToolResult hooks (LOU-E2) can wrap it uniformly via
   * try/finally regardless of which branch below returns or throws.
   */
  private static async doExecuteToolCall(
    toolCall: ToolCall,
    toolRegistry?: ToolRegistry,
    sandbox: SandboxAdapter = NoopSandbox,
    overrideArgs?: Record<string, unknown>
  ): Promise<{
    toolCallId: string;
    toolName: string;
    result: any;
    error?: string;
    requiresApproval?: boolean;
    args?: Record<string, unknown>;
  }> {
    if (!toolRegistry) {
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        result: null,
        error: 'No tool registry available',
      };
    }

    try {
      const toolDesc = toolRegistry.get(toolCall.function.name);
      if (!toolDesc || !toolDesc.tool || !toolDesc.tool.execute) {
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          result: null,
          error: `Tool '${toolCall.function.name}' not found`,
        };
      }

      // `overrideArgs` is the (possibly hook-mutated) object built by
      // executeToolCall() before preToolCall hooks ran - using it here
      // instead of re-parsing `toolCall.function.arguments` is what makes a
      // `preToolCall` hook (e.g. redact-pii) that mutates `ctx.args`
      // actually affect what the tool is invoked with.
      const args = overrideArgs ?? JSON.parse(toolCall.function.arguments);

      const needsApproval =
        typeof toolDesc.needsApproval === 'function'
          ? await toolDesc.needsApproval(args)
          : !!toolDesc.needsApproval;

      if (needsApproval) {
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          result: null,
          requiresApproval: true,
          args,
        };
      }

      // The 'ai' SDK tool.execute expects (args, context). Tools flagged
      // `requiresSandbox` (LOU-F5) are routed through the configured
      // SandboxAdapter instead of being invoked directly here; a tool
      // WITHOUT the flag takes this exact, unchanged branch. This
      // branching now lives in the shared executeToolWithSandboxGuard()
      // helper (LOU-F fix) so FlowExecutor.ts and resume.ts share the
      // exact same fail-closed behavior instead of each reimplementing it.
      const result = await executeToolWithSandboxGuard(
        toolCall.function.name,
        toolDesc,
        args,
        sandbox
      );

      return {
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        result,
      };
    } catch (error) {
      // Errors that mark themselves as `PropagatingToolError` (e.g.
      // DelegationDepthExceededError) must NOT be converted into a
      // conversational {error} tool-result - that would hand the LLM
      // exactly the kind of "your tool call failed, try again" signal
      // that triggers another delegation attempt, defeating the whole
      // point of the depth guard. Rethrow so it propagates out of
      // execute() as a rejected promise instead.
      if (error instanceof PropagatingToolError) {
        throw error;
      }

      return {
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        result: null,
        error: (error as Error).message,
      };
    }
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
