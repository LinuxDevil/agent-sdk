import { SDKError } from '../execution/errors';
// LOU-R1: registers the built-in providers lazily on the first create()
// miss (see ./builtinProviders.ts), so 'openai'/'anthropic'/'openrouter'/
// 'ollama'/'mock' resolve from any import path - not only after
// src/index.ts or ./index has been imported. The edge is one-directional
// (LOU-R27): builtinProviders receives this registry as an argument, so
// nothing reachable from it imports llm.ts back.
import { ensureBuiltinProviders } from './builtinProviders';
/**
 * LLM Provider Abstraction
 * Framework-agnostic interface for LLM providers
 */

import type { ReasoningOption } from './reasoning';
import type { HostedTool, HostedToolType } from '../tools/hosted';
import type { StandardSchemaV1 } from '../utils/zodCompat';

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
   * LOU-V13: for an `assistant` tool-call turn, the model's signed reasoning
   * blocks (Anthropic thinking), which the Anthropic provider sends back
   * unchanged with this turn, as its API requires. Never sent as text; other
   * providers ignore it.
   */
  reasoning?: ReasoningBlock[];
  /**
   * Application data attached to the message. Providers never send it to
   * the model. The compaction strategies read `metadata.pinned` (set it with
   * `pinMessage()`): a pinned message is never pruned or summarized.
   */
  metadata?: Record<string, unknown>;
}

/**
 * One block of model reasoning (LOU-V13): its text, plus what the provider
 * needs to accept it back - Anthropic's `signature`, or the encrypted data
 * of a redacted thinking block (whose `text` is empty).
 */
export interface ReasoningBlock {
  text: string;
  signature?: string;
  redactedData?: string;
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
 * N1a: a tool call the provider ran inside the request (a hosted tool such as
 * web search), with its result. The SDK never runs these calls; they are
 * reported in events (`executedBy: 'provider'`) and in the step's assistant
 * message `metadata.hostedToolCalls`.
 */
export interface HostedToolCall {
  id: string;
  /** The hosted tool's name (e.g. `web_search`). */
  name: string;
  /** The input the model gave the tool. */
  args: unknown;
  /** The provider's result, when it reported one. */
  result?: unknown;
  /** `true` when the provider reported the call as failed (`result` holds the error). */
  isError?: boolean;
  /** URL sources the provider cited after this call (web search). */
  sources?: Array<{ url: string; title?: string }>;
}

/**
 * Tool definition
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    /**
     * The tool's input schema: a JSON Schema object, an `ai.jsonSchema()`
     * wrapper, or a Standard Schema (e.g. a zod schema) - the providers all
     * pass a Standard Schema through as `inputSchema`.
     */
    parameters: Record<string, unknown> | StandardSchemaV1;
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
  /**
   * N1a: tools the provider runs itself (`webSearch()`, ...), sent with the
   * function tools. A provider that cannot send one rejects the call with
   * `LOUSHO_HOSTED_TOOL_UNSUPPORTED`. AgentExecutor sets it on every call.
   */
  hostedTools?: readonly HostedTool[];
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
   * LOU-V13: how much the model should reason before it answers. The
   * built-in providers send it only to model families known to accept it
   * (or with `force: true`); `'none'` sends nothing. See docs/reasoning.md.
   */
  reasoning?: ReasoningOption;
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
  /** Calls of local tools for AgentExecutor to run (never a provider-executed call). */
  toolCalls?: ToolCall[];
  /** N1a: the hosted tool calls the provider ran during this call, in call order. */
  hostedToolCalls?: HostedToolCall[];
  /** LOU-V13: the model's reasoning, in blocks, when it reported any. */
  reasoning?: ReasoningBlock[];
  rawResponse?: unknown;
}

/**
 * Stream chunk types. LOU-V13: `reasoning-delta` carries reasoning text in
 * `textDelta`; `reasoning-end` closes a block, with its `reasoning` data.
 * N1a: `hosted-tool-call` / `hosted-tool-result` carry a provider-executed
 * call in `hostedToolCall` (without, then with, its result and sources).
 */
export type StreamChunkType =
  | 'text-delta'
  | 'reasoning-delta'
  | 'reasoning-end'
  | 'tool-call'
  | 'hosted-tool-call'
  | 'hosted-tool-result'
  | 'tool-result'
  | 'finish'
  | 'error';

/**
 * Stream chunk
 */
export interface StreamChunk {
  type: StreamChunkType;
  textDelta?: string;
  /** On `reasoning-end`: the block's signature or redacted data (its text came in the deltas). */
  reasoning?: Omit<ReasoningBlock, 'text'>;
  toolCall?: ToolCall;
  /** N1a: on `hosted-tool-call` / `hosted-tool-result`. */
  hostedToolCall?: HostedToolCall;
  toolResult?: {
    toolCallId: string;
    result: unknown;
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

  /**
   * N1a: whether this provider can send a hosted tool of `type` (`'custom'`:
   * a `hostedTool()` pass-through). AgentExecutor asks before a run with
   * hosted tools; a provider without this method supports none.
   */
  supportsHostedTool?(type: HostedToolType | 'custom'): boolean;
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
  [key: string]: unknown;
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
    // On a miss, register the built-ins first (LOU-R1): entry points that
    // never load src/index.ts - deep imports, `lousho dev`/`chat`/`acp`,
    // generated deploy servers - otherwise saw only 'mock'. Only missing
    // names are filled in, so explicit register() calls always win.
    if (!this.providers.has(name.toLowerCase())) ensureBuiltinProviders(LLMProviderRegistry);
    const factory = this.providers.get(name.toLowerCase());
    if (!factory) {
      throw new SDKError(`Provider '${name}' not found. Available: ${Array.from(this.providers.keys()).join(', ')}`, 'LOUSHO_PROVIDER_UNKNOWN');
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
