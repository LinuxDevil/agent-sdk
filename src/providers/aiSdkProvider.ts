/**
 * Shared base for the 'ai'-SDK-backed providers
 *
 * OpenAIProvider, AnthropicProvider, OllamaProvider and OpenRouterProvider are
 * all thin adapters over the same 'ai' SDK calls (generateText/streamText):
 * they only differ in which model factory they use, their default model, and
 * their model capability/listing methods. Everything else - message
 * conversion (including tool-call turns), tool conversion, call settings, tool-call and
 * finish-reason mapping, and the StreamResult/StreamChunk shape - lives here.
 *
 * This module deliberately imports only from 'ai' (never from the optional
 * peer deps `@ai-sdk/openai`, `@ai-sdk/anthropic` or `ollama-ai-provider`), so
 * importing one provider never pulls in another provider's optional peer.
 */

import {
  generateText,
  streamText,
  tool as aiTool,
  LanguageModel,
  ToolSet,
  CoreMessage,
  CoreAssistantMessage,
  CoreToolMessage,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from 'ai';
import {
  LLMProvider,
  LLMProviderConfig,
  GenerateOptions,
  GenerateResult,
  StreamResult,
  StreamChunk,
  Message,
  ToolCall,
  ToolDefinition,
} from './llm';

/** Config fields shared by every 'ai'-SDK-backed provider. */
export interface AiSdkProviderConfig extends LLMProviderConfig {
  defaultModel?: string;
}

type TokenUsage = GenerateResult['usage'];

/** The subset of an 'ai' SDK tool call this module reads. */
interface AiSdkToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/** The subset of the 'ai' SDK streamText() result this module reads. */
interface AiSdkStreamResult {
  textStream: AsyncIterable<string>;
  text: PromiseLike<string>;
  usage: PromiseLike<TokenUsage>;
  finishReason: PromiseLike<string>;
  toolCalls: PromiseLike<AiSdkToolCall[]>;
}

/** `JSON.parse(text)`, or `fallback` when `text` is not a JSON string. */
function parseJsonOr(text: unknown, fallback: unknown): unknown {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * An assistant turn that made tool calls becomes an optional text part
 * followed by one `tool-call` part per call. Arguments are decoded from our
 * JSON string to the object the 'ai' SDK expects (`{}` if unparseable, so
 * the turn is still accepted by providers that require an object).
 */
function toAssistantToolCallMessage(msg: Message, toolCalls: ToolCall[]): CoreAssistantMessage {
  const parts: Array<TextPart | ToolCallPart> = msg.content ? [{ type: 'text', text: msg.content }] : [];
  for (const tc of toolCalls) {
    parts.push({
      type: 'tool-call',
      toolCallId: tc.id,
      toolName: tc.function.name,
      args: parseJsonOr(tc.function.arguments, {}),
    });
  }
  return { role: 'assistant', content: parts };
}

/**
 * A tool message becomes a `tool-result` part linked to its call. The
 * result is decoded from JSON (providers JSON-encode it again on the wire,
 * so passing our encoded string would double-encode it); non-JSON text and
 * non-string content are passed through unchanged.
 */
function toToolResultMessage(msg: Message, toolNames: Map<string, string>): CoreToolMessage {
  const toolCallId = msg.toolCallId ?? '';
  const part: ToolResultPart = {
    type: 'tool-result',
    toolCallId,
    toolName: msg.toolName ?? msg.name ?? toolNames.get(toolCallId) ?? 'unknown',
    result: parseJsonOr(msg.content, msg.content),
  };
  if (msg.isError) part.isError = true;
  return { role: 'tool', content: [part] };
}

/**
 * Convert our Message history to 'ai' SDK CoreMessages, preserving the
 * assistant's tool-call turns and linking each tool result to its call by
 * id, as every provider (OpenAI, Anthropic, Ollama, OpenRouter) requires.
 */
function toCoreMessages(messages: Message[]): CoreMessage[] {
  const toolNames = new Map<string, string>();
  return messages.map((msg): CoreMessage => {
    if (msg.role === 'tool') {
      return toToolResultMessage(msg, toolNames);
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) toolNames.set(tc.id, tc.function.name);
      return toAssistantToolCallMessage(msg, msg.toolCalls);
    }
    return { role: msg.role, content: msg.content ?? '' };
  });
}

/**
 * Convert our tool definitions to 'ai' SDK tools, or `undefined` when there
 * are none (the 'ai' SDK treats an empty tool set differently from no tools).
 */
function convertTools(toolDefs: ToolDefinition[] | undefined): ToolSet | undefined {
  const tools: ToolSet = {};
  for (const toolDef of toolDefs ?? []) {
    const params = toolDef.function.parameters;
    tools[toolDef.function.name] = aiTool({
      description: toolDef.function.description,
      parameters: params as any, // Type assertion since we know it's compatible
      execute: async () => {
        // This is just a placeholder, actual execution happens in AgentExecutor
        return null;
      },
    });
  }
  return Object.keys(tools).length > 0 ? tools : undefined;
}

/**
 * Convert tool calls from 'ai' SDK format to our format
 */
function convertToolCalls(calls: AiSdkToolCall[]): ToolCall[] {
  return calls.map((tc) => ({
    id: tc.toolCallId,
    type: 'function' as const,
    function: {
      name: tc.toolName,
      arguments: JSON.stringify(tc.args),
    },
  }));
}

const FINISH_REASONS = new Map<string, GenerateResult['finishReason']>([
  ['stop', 'stop'],
  ['length', 'length'],
  ['tool-calls', 'tool_calls'],
  ['content-filter', 'content_filter'],
]);

/** Map an 'ai' SDK finish reason to ours; anything unrecognised is 'error'. */
function mapFinishReason(reason: string): GenerateResult['finishReason'] {
  return FINISH_REASONS.get(reason) ?? 'error';
}

function toUsage(usage: TokenUsage): TokenUsage {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  };
}

/** Yield every text delta, then a single finish chunk carrying usage stats. */
async function* toFullStream(result: AiSdkStreamResult): AsyncGenerator<StreamChunk> {
  for await (const delta of result.textStream) {
    const chunk: StreamChunk = {
      type: 'text-delta',
      textDelta: delta,
    };
    yield chunk;
  }

  // Wait for final result to get usage stats
  const [, finalUsage, finalReason] = await Promise.all([
    result.text,
    result.usage,
    result.finishReason,
  ]);

  // Emit finish event
  const chunk: StreamChunk = {
    type: 'finish',
    finishReason: finalReason,
    usage: toUsage(finalUsage),
  };
  yield chunk;
}

async function* toTextStream(result: AiSdkStreamResult): AsyncGenerator<string> {
  for await (const delta of result.textStream) {
    yield delta;
  }
}

/** Adapt an 'ai' SDK streamText() result to our StreamResult shape. */
function toStreamResult(result: AiSdkStreamResult): StreamResult {
  // Return promises for final values
  return {
    textStream: toTextStream(result),
    fullStream: toFullStream(result),
    text: (async () => result.text)(),
    usage: (async () => toUsage(await result.usage))(),
    finishReason: (async () => result.finishReason)(),
    toolCalls: (async () => convertToolCalls(await result.toolCalls))(),
  };
}

/**
 * Base class for providers built on the 'ai' SDK. Subclasses supply the
 * model factory (createModel), the fallback model id, and the capability /
 * model-listing methods; they may override convertMessages().
 */
export abstract class AiSdkProvider<TConfig extends AiSdkProviderConfig> implements LLMProvider {
  abstract readonly name: string;
  protected config: TConfig;

  /** Model id used when neither the call nor the config names one. */
  protected abstract readonly fallbackModel: string;

  constructor(config: TConfig) {
    this.config = config;
  }

  /** The configured `defaultModel`, else this provider's built-in default. */
  get defaultModel(): string {
    return this.config.defaultModel || this.fallbackModel;
  }

  /** Build the 'ai' SDK language model for a model id. */
  protected abstract createModel(modelId: string): LanguageModel;

  /** Convert our messages to 'ai' SDK CoreMessages. */
  protected convertMessages(messages: Message[]): CoreMessage[] {
    return toCoreMessages(messages);
  }

  /** The call settings shared by generate() and stream(). */
  private buildCallSettings(options: GenerateOptions) {
    return {
      model: this.createModel(options.model || this.defaultModel),
      messages: this.convertMessages(options.messages),
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      seed: options.seed,
      tools: convertTools(options.tools),
      maxSteps: 1, // Single step - tool execution happens in AgentExecutor
      abortSignal: options.signal,
    };
  }

  /**
   * Generate text without streaming
   */
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const result = await generateText(this.buildCallSettings(options));

    return {
      text: result.text,
      finishReason: mapFinishReason(result.finishReason),
      usage: toUsage(result.usage),
      toolCalls: result.toolCalls && convertToolCalls(result.toolCalls),
      rawResponse: result,
    };
  }

  /**
   * Generate text with streaming
   */
  async stream(options: GenerateOptions): Promise<StreamResult> {
    const result = await streamText(this.buildCallSettings(options));
    return toStreamResult(result);
  }

  abstract supportsTools(model: string): boolean;
  abstract supportsStreaming(model: string): boolean;
  abstract getModels(): Promise<string[]>;
}
