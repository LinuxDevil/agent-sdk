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
} from './llm';

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
  private responseIndex = 0;
  private responses: string[];
  private delay: number;
  private simulateError: boolean;
  private errorMessage: string;

  constructor(config: MockProviderConfig) {
    this.responses = config.responses || ['This is a mock response.'];
    this.delay = config.delay || 0;
    this.simulateError = config.simulateError || false;
    this.errorMessage = config.errorMessage || 'Mock error';
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    if (this.simulateError) {
      throw new Error(this.errorMessage);
    }

    if (this.delay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delay));
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

  async stream(options: GenerateOptions): Promise<StreamResult> {
    if (this.simulateError) {
      throw new Error(this.errorMessage);
    }

    const text = this.getNextResponse();
    const words = text.split(' ');
    const chunks: StreamChunk[] = [];

    const fullStreamGenerator = async function* (
      this: MockLLMProvider
    ): AsyncGenerator<StreamChunk> {
      for (const word of words) {
        if (this.delay > 0) {
          await new Promise(resolve => setTimeout(resolve, this.delay));
        }

        const chunk: StreamChunk = {
          type: 'text-delta',
          textDelta: word + ' ',
        };
        chunks.push(chunk);
        yield chunk;
      }

      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: {
          promptTokens: this.countTokens(options.messages),
          completionTokens: words.length,
          totalTokens: this.countTokens(options.messages) + words.length,
        },
      };
    }.bind(this);

    const textStreamGenerator = async function* (): AsyncGenerator<string> {
      for (const word of words) {
        yield word + ' ';
      }
    };

    return {
      fullStream: fullStreamGenerator(),
      textStream: textStreamGenerator(),
      text: Promise.resolve(text),
      usage: Promise.resolve({
        promptTokens: this.countTokens(options.messages),
        completionTokens: words.length,
        totalTokens: this.countTokens(options.messages) + words.length,
      }),
      finishReason: Promise.resolve('stop'),
      toolCalls: Promise.resolve([]),
    };
  }

  supportsTools(model: string): boolean {
    return true;
  }

  supportsStreaming(model: string): boolean {
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
      if (lastMessage.content.toLowerCase().includes(tool.function.name.toLowerCase())) {
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

  private countTokens(messages: any[]): number {
    // Simple approximation: 1 token per 4 characters
    return Math.ceil(
      messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) / 4
    );
  }
}

/**
 * Create mock provider
 */
export function createMockProvider(config: MockProviderConfig = { name: 'mock' }): MockLLMProvider {
  return new MockLLMProvider(config);
}
