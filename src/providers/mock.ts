/**
 * Mock LLM Provider
 * For testing and development
 */

import {
  LLMProvider,
  LLMProviderConfig,
  GenerateOptions,
  GenerateResult,
  StreamResult,
  StreamChunk,
  ToolCall,
  Message,
} from './llm';
import { abortableDelay } from './abortableDelay';
import { textOf } from './content';
import { LLMProviderError } from '../execution/errors';

/**
 * Mock response configuration
 */
export interface MockProviderConfig extends LLMProviderConfig {
  responses?: string[];
  delay?: number;
  simulateError?: boolean;
  errorMessage?: string;
}

/**
 * Mock LLM Provider
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  /** The `defaultModel` the mock was configured with, if any. */
  readonly defaultModel?: string;
  private responseIndex = 0;
  private responses: string[];
  private delay: number;
  private simulateError: boolean;
  private errorMessage: string;

  constructor(config: MockProviderConfig) {
    this.defaultModel = config.defaultModel;
    this.responses = config.responses || ['This is a mock response.'];
    this.delay = config.delay || 0;
    this.simulateError = config.simulateError || false;
    this.errorMessage = config.errorMessage || 'Mock error';
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    options.signal?.throwIfAborted();
    if (this.simulateError) {
      throw new LLMProviderError(this.errorMessage, 'mock');
    }

    if (this.delay > 0) {
      await abortableDelay(this.delay, options.signal);
    }

    const text = this.getNextResponse();
    const toolCalls = this.extractToolCalls(options);

    return {
      text,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: {
        promptTokens: this.countTokens(options.messages),
        completionTokens: this.countTokens([{ role: 'assistant', content: text }]),
        totalTokens: this.countTokens(options.messages) + this.countTokens([{ role: 'assistant', content: text }]),
      },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  /**
   * Streams the same step `generate()` would return - the same text (in
   * word-sized `text-delta` chunks whose concatenation is that text), the
   * same tool calls, finish reason and usage - so a run gets the same result
   * whether it generates or streams its model calls (M9).
   */
  async stream(options: GenerateOptions): Promise<StreamResult> {
    options.signal?.throwIfAborted();
    if (this.simulateError) {
      throw new LLMProviderError(this.errorMessage, 'mock');
    }

    const text = this.getNextResponse();
    const toolCalls = this.extractToolCalls(options);
    const finishReason: GenerateResult['finishReason'] = toolCalls.length > 0 ? 'tool_calls' : 'stop';
    const promptTokens = this.countTokens(options.messages);
    const completionTokens = this.countTokens([{ role: 'assistant', content: text }]);
    const usage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
    // Word-sized chunks ("This ", "is ", ..., "response.") that add up to `text`.
    const deltas = text.match(/\S+\s*|\s+/g) ?? [];

    const fullStreamGenerator = async function* (this: MockLLMProvider): AsyncGenerator<StreamChunk> {
      for (const textDelta of deltas) {
        if (this.delay > 0) {
          await abortableDelay(this.delay, options.signal);
        }
        yield { type: 'text-delta', textDelta };
      }
      for (const toolCall of toolCalls) {
        yield { type: 'tool-call', toolCall };
      }
      yield { type: 'finish', finishReason, usage };
    }.bind(this);

    const textStreamGenerator = async function* (): AsyncGenerator<string> {
      yield* deltas;
    };

    return {
      fullStream: fullStreamGenerator(),
      textStream: textStreamGenerator(),
      text: Promise.resolve(text),
      usage: Promise.resolve(usage),
      finishReason: Promise.resolve(finishReason),
      toolCalls: Promise.resolve(toolCalls),
    };
  }

  supportsTools(_model: string): boolean {
    return true;
  }

  supportsStreaming(_model: string): boolean {
    return true;
  }

  async getModels(): Promise<string[]> {
    return ['mock-model-1', 'mock-model-2'];
  }

  private getNextResponse(): string {
    const response = this.responses[this.responseIndex % this.responses.length];
    this.responseIndex++;
    return response;
  }

  private extractToolCalls(options: GenerateOptions): ToolCall[] {
    // Simple mock: if tools are defined and message mentions tool name, simulate a call
    if (!options.tools || options.tools.length === 0) {
      return [];
    }

    const lastMessage = options.messages[options.messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'user') {
      return [];
    }

    // Check if message mentions any tool name
    for (const tool of options.tools) {
      if (textOf(lastMessage).toLowerCase().includes(tool.function.name.toLowerCase())) {
        return [
          {
            id: `call_${Date.now()}`,
            type: 'function',
            function: {
              name: tool.function.name,
              arguments: JSON.stringify({ input: 'mock input' }),
            },
          },
        ];
      }
    }

    return [];
  }

  private countTokens(messages: Message[]): number {
    // Simple approximation: 1 token per 4 characters
    return Math.ceil(
      messages.reduce((sum, msg) => sum + textOf(msg).length, 0) / 4
    );
  }
}

/**
 * Create mock provider
 */
export function createMockProvider(config: MockProviderConfig = { name: 'mock' }): MockLLMProvider {
  return new MockLLMProvider(config);
}

// 'mock' is registered into LLMProviderRegistry centrally, alongside the
// real providers, by ./builtinProviders.ts's ensureBuiltinProviders() -
// which LLMProviderRegistry.create() calls on a miss (LOU-R1). That covers
// every entry point (specToAgent/`lousho dev`, deep imports, deploy
// bundles) without this module needing a top-level side effect. Keeping a
// module-scope register() here is not just redundant but unsafe: llm.ts ->
// builtinProviders.ts -> the provider modules -> llm.ts is now a cycle, so
// a top-level LLMProviderRegistry.register() in this file could run while
// llm.ts is still being initialized.
