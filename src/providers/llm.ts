/**
 * LLM Provider Abstraction
 * Framework-agnostic interface for LLM providers
 */

/**
 * Message role types
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** A text part of a multimodal message (LOU-V11). */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/**
 * An image part of a multimodal message (LOU-V11): an `http(s)` URL, a
 * `data:` URL or the raw bytes. `mimeType` is optional (the `ai` SDK
 * detects it from the bytes or the data URL).
 */
export interface ImageContentPart {
  type: 'image';
  image: string | Uint8Array;
  mimeType?: string;
}

/** A file part of a multimodal message (LOU-V11): a URL, a `data:` URL or the raw bytes. */
export interface FileContentPart {
  type: 'file';
  data: string | Uint8Array;
  mimeType: string;
  filename?: string;
}

/** One part of a multimodal `Message.content` (LOU-V11). */
export type ContentPart = TextContentPart | ImageContentPart | FileContentPart;

/**
 * Message structure
 */
export interface Message {
  role: MessageRole;
  /**
   * Message text, or (LOU-V11) a list of text, image and file parts. The
   * built-in providers send image and file parts on `user` messages only;
   * on other messages they send the text parts (`textOf()`). For a `tool`
   * message this is the tool's result, usually JSON-encoded (providers
   * decode it back to a value before sending it).
   *
   * @example
   * { role: 'user', content: [
   *   { type: 'text', text: 'What is in this picture?' },
   *   { type: 'image', image: 'https://example.com/cat.png' },
   * ] }
   */
  content: string | ContentPart[];
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
  /**
   * Application data attached to the message. Providers never send it to
   * the model. The compaction strategies read `metadata.pinned` (set it with
   * `pinMessage()`): a pinned message is never pruned or summarized.
   */
  metadata?: Record<string, unknown>;
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
  /**
   * Model id for this call. Optional: when omitted (or empty) the provider
   * uses the model it was constructed with (`defaultModel`) and then its own
   * built-in default. For agents the precedence is `agent.settings.model` >
   * the provider's configured model > the provider's built-in default.
   */
  model?: string;
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
  /**
   * Asks for a JSON reply (LOU-V4). AgentExecutor sets it on every call of a
   * run with an `output` schema. A hint: a provider with a JSON mode uses it
   * (the `ai`-SDK providers pass it on as `experimental_output`), others
   * ignore it. The executor parses and validates the reply either way.
   */
  responseFormat?: { type: 'json'; schema?: Record<string, unknown> };
  /**
   * Cancels the request. Providers must reject promptly (with the signal's
   * `reason`, normally an `AbortError`) once it is aborted. AgentExecutor
   * sets this from `ExecuteOptions.signal`.
   *
   * @example
   * ```ts
   * await provider.generate({ messages, signal: AbortSignal.timeout(10_000) });
   * ```
   */
  signal?: AbortSignal;
}

/**
 * Token usage as a provider reports it (the 'ai' SDK's naming). AgentExecutor
 * converts it to the normalized `Usage` (`inputTokens`/`outputTokens`).
 */
export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider's cache, when the provider reports it. */
  cachedInputTokens?: number;
  /** Tokens spent on hidden reasoning, when the provider reports it. */
  reasoningTokens?: number;
}

/**
 * Generation result
 */
export interface GenerateResult {
  text: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  /**
   * Token usage of this call. Leave it `undefined` when the backend reports
   * nothing - never fill in zeros: AgentExecutor then estimates the tokens
   * and flags the run's usage as `estimated`.
   */
  usage?: ProviderUsage;
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
  /** Usage of the call, on the `finish` chunk; omit when the backend reports none (see GenerateResult.usage). */
  usage?: ProviderUsage;
  error?: Error;
}

/**
 * Stream result
 */
export interface StreamResult {
  textStream: AsyncIterable<string>;
  fullStream: AsyncIterable<StreamChunk>;
  text: Promise<string>;
  /** Resolves to `undefined` when the backend reports no usage (see GenerateResult.usage). */
  usage: Promise<ProviderUsage | undefined>;
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
   * The model this provider uses when a call names none: the `defaultModel`
   * it was constructed with (e.g. via `resolveProvider('openai/gpt-4o-mini')`),
   * else its built-in default. Providers that cannot report one may omit it;
   * the executor then sends no model and the provider decides.
   */
  readonly defaultModel?: string;

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
