/**
 * Agent Executor
 * Executes agents with streaming support and tool calling
 */

import { LLMProvider, Message, ToolCall } from '../providers';
import { AgentConfig } from '../types';
import { ToolRegistry } from '../tools';

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
    } = options;

    // Emit start event
    this.emitEvent(onEvent, {
      type: 'start',
      timestamp: new Date(),
      agentId: agent.id,
      agentName: agent.name,
    });

    // Build messages
    const messages = this.buildMessages(agent, input);

    // Build tools
    const tools = this.buildTools(agent, toolRegistry);

    let currentMessages = [...messages];
    let allToolCalls: ToolCall[] = [];
    let totalUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let steps = 0;
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
    input: string | Message[]
  ): Message[] {
    const messages: Message[] = [];

    // Add system prompt
    if (agent.prompt) {
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
    toolRegistry?: ToolRegistry
  ): Promise<{
    toolCallId: string;
    toolName: string;
    result: any;
    error?: string;
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
