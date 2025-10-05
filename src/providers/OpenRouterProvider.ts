/**
 * OpenRouter Provider Implementation
 * Uses OpenAI-compatible API through the 'ai' SDK
 */

import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, tool as aiTool } from 'ai';
import {
  LLMProvider,
  GenerateOptions,
  GenerateResult,
  StreamResult,
  StreamChunk,
  LLMProviderConfig,
  Message,
} from './llm';

export interface OpenRouterProviderConfig extends LLMProviderConfig {
  apiKey: string;
  siteUrl?: string;
  siteName?: string;
  defaultModel?: string;
}

/**
 * Convert our Message type to 'ai' SDK CoreMessage
 */
function convertMessages(messages: Message[]): any[] {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      // Tool result messages
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: msg.toolCallId || '',
            toolName: msg.toolName || 'unknown',
            result: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          },
        ],
      };
    }
    
    // Handle assistant messages with tool calls
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const toolInvocations = msg.toolCalls.map(tc => ({
        type: 'tool-call' as const,
        toolCallId: tc.id,
        toolName: tc.function.name,
        args: typeof tc.function.arguments === 'string' 
          ? JSON.parse(tc.function.arguments) 
          : tc.function.arguments,
      }));
      
      return {
        role: 'assistant',
        content: [
          ...(msg.content ? [{ type: 'text', text: msg.content }] : []),
          ...toolInvocations,
        ],
      };
    }
    
    // Regular messages
    return {
      role: msg.role,
      content: msg.content || '',
    };
  });
}

/**
 * OpenRouter Provider using OpenAI-compatible API
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  private provider: ReturnType<typeof createOpenAI>;
  private config: OpenRouterProviderConfig;

  constructor(config: OpenRouterProviderConfig) {
    this.config = config;
    
    // Build headers with optional site attribution
    const headers: Record<string, string> = {
      ...(config.headers || {}),
    };
    
    if (config.siteUrl) {
      headers['HTTP-Referer'] = config.siteUrl;
    }
    
    if (config.siteName) {
      headers['X-Title'] = config.siteName;
    }

    // Create OpenAI provider with OpenRouter endpoint
    this.provider = createOpenAI({
      apiKey: config.apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      headers,
    });
  }

  /**
   * Generate text without streaming
   */
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const model = this.provider(options.model || this.config.defaultModel || 'openai/gpt-3.5-turbo');

    // Convert tools if provided
    const tools: Record<string, any> = {};
    if (options.tools) {
      for (const toolDef of options.tools) {
        const params = toolDef.function.parameters;
        tools[toolDef.function.name] = aiTool({
          description: toolDef.function.description,
          parameters: params as any,
          execute: async () => {
            // Placeholder - actual execution happens in AgentExecutor
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
      maxSteps: 1,
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
    const model = this.provider(options.model || this.config.defaultModel || 'openai/gpt-3.5-turbo');

    // Convert tools if provided
    const tools: Record<string, any> = {};
    if (options.tools) {
      for (const toolDef of options.tools) {
        const params = toolDef.function.parameters;
        tools[toolDef.function.name] = aiTool({
          description: toolDef.function.description,
          parameters: params as any,
          execute: async () => {
            // Placeholder - actual execution happens in AgentExecutor
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
      maxSteps: 1,
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
   * Most OpenRouter models support tools, especially OpenAI and Anthropic models
   */
  supportsTools(model: string): boolean {
    // OpenAI models
    if (model.includes('gpt-4') || model.includes('gpt-3.5-turbo')) {
      return true;
    }
    
    // Anthropic models
    if (model.includes('claude')) {
      return true;
    }
    
    // Google models
    if (model.includes('gemini')) {
      return true;
    }
    
    // Mistral models
    if (model.includes('mistral')) {
      return true;
    }
    
    // Default to true for most models
    return true;
  }

  /**
   * Check if model supports streaming
   */
  supportsStreaming(model: string): boolean {
    return true; // All OpenRouter models support streaming
  }

  /**
   * Get available models from OpenRouter
   */
  async getModels(): Promise<string[]> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.statusText}`);
      }

      const data = await response.json();
      return data.data?.map((model: any) => model.id) || [];
    } catch (error) {
      console.warn('Failed to fetch OpenRouter models:', error);
      
      // Return some popular models as fallback
      return [
        'openai/gpt-4o',
        'openai/gpt-4o-mini',
        'openai/gpt-4-turbo',
        'openai/gpt-3.5-turbo',
        'anthropic/claude-3.5-sonnet',
        'anthropic/claude-3-opus',
        'anthropic/claude-3-haiku',
        'google/gemini-pro',
        'google/gemini-pro-1.5',
        'meta-llama/llama-3.1-70b-instruct',
        'meta-llama/llama-3.1-8b-instruct',
        'mistralai/mistral-large',
        'mistralai/mixtral-8x7b-instruct',
      ];
    }
  }

  /**
   * Get model information including pricing
   */
  async getModelInfo(modelId: string): Promise<any> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch model info: ${response.statusText}`);
      }

      const data = await response.json();
      return data.data?.find((model: any) => model.id === modelId);
    } catch (error) {
      console.warn('Failed to fetch model info:', error);
      return null;
    }
  }
}
