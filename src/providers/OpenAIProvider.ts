/**
 * OpenAI Provider Implementation
 * Uses the 'ai' SDK for unified interface
 */

import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, tool as aiTool, CoreMessage } from 'ai';
import {
  LLMProvider,
  GenerateOptions,
  GenerateResult,
  StreamResult,
  StreamChunk,
  LLMProviderConfig,
  Message,
} from './llm';

export interface OpenAIProviderConfig extends LLMProviderConfig {
  apiKey: string;
  organization?: string;
  baseURL?: string;
  defaultModel?: string;
}

/**
 * Convert our Message type to 'ai' SDK CoreMessage
 */
function convertMessages(messages: Message[]): any[] {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: msg.toolCallId || '',
            toolName: msg.name || 'unknown',
            result: msg.content,
          },
        ],
      };
    }
    // For other roles, return as-is
    return {
      role: msg.role,
      content: msg.content,
      ...(msg.toolCalls && { toolCalls: msg.toolCalls }),
    };
  });
}

/**
 * OpenAI Provider using the 'ai' SDK
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private provider: ReturnType<typeof createOpenAI>;
  private config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    this.provider = createOpenAI({
      apiKey: config.apiKey,
      organization: config.organization,
      baseURL: config.baseURL,
      headers: config.headers,
    });
  }

  /**
   * Generate text without streaming
   */
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const model = this.provider(options.model || this.config.defaultModel || 'gpt-4');

    // Convert tools if provided
    const tools: Record<string, any> = {};
    if (options.tools) {
      for (const toolDef of options.tools) {
        const params = toolDef.function.parameters;
        tools[toolDef.function.name] = aiTool({
          description: toolDef.function.description,
          parameters: params as any,
          execute: async () => {
            // This is just a placeholder, actual execution happens in AgentExecutor
            return null;
          },
        });
      }
    }

    const result = await generateText({
      model,
      messages: convertMessages(options.messages) as any,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      seed: options.seed,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      maxSteps: 1, // Single step for non-streaming
    });

    // Convert tool calls from 'ai' SDK format to our format
    const toolCalls = result.toolCalls?.map((tc: any) => ({
      id: tc.toolCallId,
      type: 'function' as const,
      function: {
        name: tc.toolName,
        arguments: JSON.stringify(tc.args),
      },
    }));

    return {
      text: result.text,
      finishReason: result.finishReason === 'stop' ? 'stop' :
                    result.finishReason === 'length' ? 'length' :
                    result.finishReason === 'tool-calls' ? 'tool_calls' :
                    result.finishReason === 'content-filter' ? 'content_filter' : 'error',
      usage: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
      },
      toolCalls,
      rawResponse: result,
    };
  }

  /**
   * Generate text with streaming
   */
  async stream(options: GenerateOptions): Promise<StreamResult> {
    const model = this.provider(options.model || this.config.defaultModel || 'gpt-4');

    // Convert tools if provided
    const tools: Record<string, any> = {};
    if (options.tools) {
      for (const toolDef of options.tools) {
        const params = toolDef.function.parameters;
        tools[toolDef.function.name] = aiTool({
          description: toolDef.function.description,
          parameters: params as any,
          execute: async () => {
            // This is just a placeholder, actual execution happens in AgentExecutor
            return null;
          },
        });
      }
    }

    const result = await streamText({
      model,
      messages: convertMessages(options.messages) as any,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      seed: options.seed,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      maxSteps: 1, // Single step for streaming
    });

    // Create text stream
    const textStream = (async function* () {
      for await (const delta of result.textStream) {
        yield delta;
      }
    })();

    // Create full stream with all event types
    const fullStream = (async function* () {
      for await (const delta of result.textStream) {
        const chunk: StreamChunk = {
          type: 'text-delta',
          textDelta: delta,
        };
        yield chunk;
      }

      // Wait for final result to get usage stats
      const [finalText, finalUsage, finalReason] = await Promise.all([
        result.text,
        result.usage,
        result.finishReason,
      ]);

      // Emit finish event
      const chunk: StreamChunk = {
        type: 'finish',
        finishReason: finalReason,
        usage: {
          promptTokens: finalUsage.promptTokens,
          completionTokens: finalUsage.completionTokens,
          totalTokens: finalUsage.totalTokens,
        },
      };
      yield chunk;
    })();

    // Return promises for final values
    return {
      textStream,
      fullStream,
      text: (async () => {
        const finalText = await result.text;
        return finalText;
      })(),
      usage: (async () => {
        const finalUsage = await result.usage;
        return {
          promptTokens: finalUsage.promptTokens,
          completionTokens: finalUsage.completionTokens,
          totalTokens: finalUsage.totalTokens,
        };
      })(),
      finishReason: (async () => {
        const reason = await result.finishReason;
        return reason;
      })(),
      toolCalls: (async () => {
        const calls = await result.toolCalls;
        return calls.map((tc: any) => ({
          id: tc.toolCallId,
          type: 'function' as const,
          function: {
            name: tc.toolName,
            arguments: JSON.stringify(tc.args),
          },
        }));
      })(),
    };
  }

  /**
   * Check if model supports tools
   */
  supportsTools(model: string): boolean {
    // Most GPT models support tools
    return model.startsWith('gpt-4') || model.startsWith('gpt-3.5-turbo');
  }

  /**
   * Check if model supports streaming
   */
  supportsStreaming(model: string): boolean {
    return true; // All OpenAI models support streaming
  }

  /**
   * Get available models
   */
  async getModels(): Promise<string[]> {
    // Return common models (fetching from API requires additional setup)
    return [
      'gpt-4',
      'gpt-4-turbo',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-3.5-turbo',
    ];
  }
}
