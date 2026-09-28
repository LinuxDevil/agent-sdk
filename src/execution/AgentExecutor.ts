/**
 * Agent Executor
 * Executes agents with streaming support and tool calling
 */

import { nanoid } from 'nanoid';
import { LLMProvider, Message, ToolCall } from '../providers';
import { AgentConfig } from '../types';
import { ToolRegistry } from '../tools';
import { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import { Checkpoint, CheckpointStore } from './checkpoint';

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
      steps = 0;
    }

    let finalText = '';
    let finishReason = 'stop';

    // Execution loop with tool calling
    while (steps < maxSteps) {
      steps++;

      try {
        const result = await provider.generate({
          model: agent.settings?.model || 'gpt-4',
          messages: currentMessages,
          temperature,
          maxTokens,
          tools: tools.length > 0 ? tools : undefined,
        });

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

            const toolResult = await this.executeToolCall(
              toolCall,
              agent,
              toolRegistry
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
