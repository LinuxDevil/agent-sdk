/**
 * LLM Provider Abstraction
 * Framework-agnostic interface for LLM providers
 */

/**
 * Message role types
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Message structure
 */
export interface Message {
  role: MessageRole;
  /**
   * Message text. For a `tool` message this is the tool's result, usually
   * JSON-encoded (providers decode it back to a value before sending it).
   */
  content: string;
  name?: string;
  /** For a `tool` message: the `ToolCall.id` this message answers. */
  toolCallId?: string;
  /** For a `tool` message: the name of the tool that produced the result. */
  toolName?: string;
  /** For an `assistant` message: the tool calls the model made this turn. */
  toolCalls?: ToolCall[];
  /**
   * For a `tool` message: `true` when the tool failed and `content` carries
   * the error (as `{"error": "..."}`) rather than a result. Providers that
   * support it (e.g. Anthropic's `is_error`) forward this to the model.
   *
   * @example
   * { role: 'tool', toolCallId: 'call_1', toolName: 'search',
   *   content: '{"error":"timeout"}', isError: true }
   */
  isError?: boolean;
}

/**
 * Tool call structure
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Tool definition
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/**
 * Generation options
 */
export interface GenerateOptions {
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  seed?: number;
}

/**
 * Generation result
 */
export interface GenerateResult {
  text: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  toolCalls?: ToolCall[];
  rawResponse?: any;
}

/**
 * Stream chunk types
 */
export type StreamChunkType = 
  | 'text-delta'
  | 'tool-call'
  | 'tool-result'
  | 'finish'
  | 'error';

/**
 * Stream chunk
 */
export interface StreamChunk {
  type: StreamChunkType;
  textDelta?: string;
  toolCall?: ToolCall;
  toolResult?: {
    toolCallId: string;
    result: any;
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
 * Stream result
 */
export interface StreamResult {
  textStream: AsyncIterable<string>;
  fullStream: AsyncIterable<StreamChunk>;
  text: Promise<string>;
  usage: Promise<{
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
  finishReason: Promise<string>;
  toolCalls: Promise<ToolCall[]>;
}

/**
 * LLM Provider interface
 */
export interface LLMProvider {
  /**
   * Provider name (e.g., 'openai', 'anthropic', 'ollama')
   */
  readonly name: string;

  /**
   * Generate text without streaming
   */
  generate(options: GenerateOptions): Promise<GenerateResult>;

  /**
   * Generate text with streaming
   */
  stream(options: GenerateOptions): Promise<StreamResult>;

  /**
   * Check if model supports tools
   */
  supportsTools(model: string): boolean;

  /**
   * Check if model supports streaming
   */
  supportsStreaming(model: string): boolean;

  /**
   * Get available models
   */
  getModels(): Promise<string[]>;
}

/**
 * LLM Provider configuration
 */
export interface LLMProviderConfig {
  name?: string;
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  timeout?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
  [key: string]: any;
}

/**
 * Provider factory function type
 */
export type ProviderFactory = (config: LLMProviderConfig) => LLMProvider;

/**
 * Provider registry
 */
export class LLMProviderRegistry {
  private static providers = new Map<string, ProviderFactory>();

  /**
   * Register a provider
   */
  static register(name: string, factory: ProviderFactory): void {
    this.providers.set(name.toLowerCase(), factory);
  }

  /**
   * Create provider instance
   */
  static create(name: string, config: LLMProviderConfig): LLMProvider {
    const factory = this.providers.get(name.toLowerCase());
    if (!factory) {
      throw new Error(`Provider '${name}' not found. Available: ${Array.from(this.providers.keys()).join(', ')}`);
    }
    return factory(config);
  }

  /**
   * Check if provider is registered
   */
  static has(name: string): boolean {
    return this.providers.has(name.toLowerCase());
  }

  /**
   * Get all registered provider names
   */
  static getProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Clear all providers (for testing)
   */
  static clear(): void {
    this.providers.clear();
  }
}
