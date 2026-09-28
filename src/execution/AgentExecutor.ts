/**
 * Agent Executor
 * Executes agents with streaming support and tool calling
 */

import { nanoid } from 'nanoid';
import { LLMProvider, Message, ToolCall, GenerateOptions, GenerateResult } from '../providers';
import { AgentConfig } from '../types';
import { ToolRegistry } from '../tools';
import { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import { Checkpoint, CheckpointStore } from './checkpoint';
import { TraceExporter, withSpan } from './tracing';

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

    if (checkpoint) {
      currentMessages = [...checkpoint.messages];
      allToolCalls = [...(checkpoint.toolCalls as ToolCall[])];
      totalUsage = { ...checkpoint.usage };
      steps = checkpoint.stepIndex;
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

        const result = await withSpan(
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

            return generated;
          },
          agentSpanId
        );

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
                  onToolResult
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
              };
              await checkpointStore.save(sessionId, checkpoint);
            }
          }

          // Continue loop for next generation
          finishReason = result.finishReason;
          continue;
        }

        // No tool calls, we're done
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
    _agent: AgentConfig,
    toolRegistry?: ToolRegistry,
    onToolCall?: ExecuteOptions['onToolCall'],
    onToolResult?: ExecuteOptions['onToolResult']
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
      outcome = await this.doExecuteToolCall(toolCall, toolRegistry);
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
    toolRegistry?: ToolRegistry
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

      const args = JSON.parse(toolCall.function.arguments);

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

      // The 'ai' SDK tool.execute expects (args, context)
      const result = await toolDesc.tool.execute(args, {} as any);

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
