/**
 * Shared base for the 'ai'-SDK-backed providers
 *
 * OpenAIProvider, AnthropicProvider, OllamaProvider and OpenRouterProvider are
 * all thin adapters over the same 'ai' SDK calls (generateText/streamText):
 * they only differ in which model factory they use, their default model, and
 * their model capability/listing methods. Everything else - message
 * conversion (including tool-call turns), tool conversion and call settings -
 * lives here; aiSdkCompat sends the call on `ai` v4 or v6/v7 and maps the
 * result, tool calls, finish reason and stream chunks back.
 *
 * This module deliberately imports only from 'ai' (never from the optional
 * peer deps `@ai-sdk/openai`, `@ai-sdk/anthropic` or `ollama-ai-provider`).
 * Subclasses load their peer lazily inside `createModel()`, on first use.
 */

import * as aiModule from 'ai';
import {
  tool as aiTool,
  LanguageModel,
  ToolSet,
  CoreMessage,
  CoreAssistantMessage,
  CoreToolMessage,
  TextPart,
  ImagePart,
  FilePart,
  ToolCallPart,
  ToolResultPart,
  Output,
} from 'ai';
import {
  LLMProvider,
  LLMProviderConfig,
  GenerateOptions,
  GenerateResult,
  StreamResult,
  Message,
  ToolCall,
  ToolDefinition,
  ContentPart,
} from './llm';
import { textOf } from './content';
import { type AiSdkMessage, type AiSdkModule, compatGenerateText, streamCompat } from './aiSdkCompat';

/** Config fields shared by every 'ai'-SDK-backed provider. */
export interface AiSdkProviderConfig extends LLMProviderConfig {
  defaultModel?: string;
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
  const text = textOf(msg);
  const parts: Array<TextPart | ToolCallPart> = text ? [{ type: 'text', text }] : [];
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
    result: Array.isArray(msg.content) ? textOf(msg) : parseJsonOr(msg.content, msg.content),
  };
  if (msg.isError) part.isError = true;
  return { role: 'tool', content: [part] };
}

/** How a provider sends multimodal parts (LOU-V11). */
interface PartSupport {
  provider: string;
  /** `false`: file parts become a text note, with a one-time warning. */
  files: boolean;
}

/** Providers already warned that they turned file parts into text. */
const warnedFileParts = new Set<string>();

/** A user content part as the 'ai' v4 `TextPart` / `ImagePart` / `FilePart`. */
function toUserPart(part: ContentPart, support: PartSupport): TextPart | ImagePart | FilePart {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image') {
    return { type: 'image', image: part.image, ...(part.mimeType ? { mimeType: part.mimeType } : {}) };
  }
  if (support.files) {
    return { type: 'file', data: part.data, mimeType: part.mimeType, ...(part.filename ? { filename: part.filename } : {}) };
  }
  if (!warnedFileParts.has(support.provider)) {
    warnedFileParts.add(support.provider);
    console.warn(`[loushy] The ${support.provider} provider cannot send file parts; they are sent as a text note.`);
  }
  return { type: 'text', text: `[file ${part.filename ?? 'attachment'} (${part.mimeType}) not sent]` };
}

/**
 * Convert our Message history to 'ai' SDK CoreMessages, preserving the
 * assistant's tool-call turns and linking each tool result to its call by
 * id, as every provider (OpenAI, Anthropic, Ollama, OpenRouter) requires.
 * Content parts (LOU-V11) are sent on user messages; other roles get their text.
 */
function toCoreMessages(messages: Message[], support: PartSupport): CoreMessage[] {
  const toolNames = new Map<string, string>();
  return messages.map((msg): CoreMessage => {
    if (msg.role === 'tool') {
      return toToolResultMessage(msg, toolNames);
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) toolNames.set(tc.id, tc.function.name);
      return toAssistantToolCallMessage(msg, msg.toolCalls);
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      return { role: 'user', content: msg.content.map((part) => toUserPart(part, support)) };
    }
    return { role: msg.role, content: textOf(msg) };
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
 * LOU-V4: `responseFormat` as an 'ai' SDK output spec - JSON mode, with the
 * schema only for models that support structured outputs (as
 * `Output.object()` does). Unlike `Output.object()` it leaves the prompt and
 * the reply text alone: AgentExecutor instructs the model and validates.
 */
function toOutput(format: GenerateOptions['responseFormat']): Output.Output<string, string> | undefined {
  if (format?.type !== 'json') return undefined;
  return {
    type: 'object',
    responseFormat: ({ model }) => ({
      type: 'json',
      schema: typeof model === 'object' && model.supportsStructuredOutputs ? format.schema : undefined,
    }),
    injectIntoSystemPrompt: ({ system }) => system,
    parsePartial: ({ text }) => ({ partial: text }),
    parseOutput: ({ text }) => text,
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

  /** The 'ai' module calls go through: the installed one (v4, v6 or v7); tests swap it. */
  protected readonly ai: AiSdkModule = aiModule;

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
  protected abstract createModel(modelId: string): LanguageModel | Promise<LanguageModel>;

  /**
   * Whether this provider's 'ai' SDK model takes `file` parts (LOU-V11). The
   * built-in providers' pinned peers (`@ai-sdk/*` 0.0.x, `ollama-ai-provider`)
   * do not, so their file parts become a text note; image parts are sent.
   */
  protected readonly acceptsFileParts: boolean = false;

  /**
   * Convert our messages to `ai` v4 CoreMessages (aiSdkCompat maps them to
   * v6/v7 ModelMessages). Typed with our structural `AiSdkMessage`, not the
   * v4 `CoreMessage` (which `ai` v6/v7 do not export), since LOU-D27; an
   * override returning `CoreMessage[]` still compiles.
   *
   * @deprecated An `ai` v4-shaped hook, kept for the built-in providers.
   * Do not override it in new code: LOU-D28 replaces it with a hook on our
   * own `Message[]`.
   */
  protected convertMessages(messages: Message[]): AiSdkMessage[] {
    return toCoreMessages(messages, { provider: this.name, files: this.acceptsFileParts });
  }

  /** The call settings shared by generate() and stream(). */
  private async buildCallSettings(options: GenerateOptions) {
    return {
      model: await this.createModel(options.model || this.defaultModel),
      messages: this.convertMessages(options.messages),
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      seed: options.seed,
      tools: convertTools(options.tools),
      maxSteps: 1, // Single step - tool execution happens in AgentExecutor
      // The 'ai' SDK's own retries (its default is 2). createAgent() resolves
      // providers with 0 and retries in its withRetry() wrapper instead.
      maxRetries: this.config.maxRetries ?? 2,
      abortSignal: options.signal,
      experimental_output: toOutput(options.responseFormat),
    };
  }

  /**
   * Generate text without streaming, on `ai` v4 or v6/v7 (LOU-D26).
   */
  async generate(options: GenerateOptions): Promise<GenerateResult> {
    return compatGenerateText(this.ai, await this.buildCallSettings(options), options);
  }

  /**
   * Generate text with streaming, on `ai` v4 or v6/v7 (LOU-D27).
   */
  async stream(options: GenerateOptions): Promise<StreamResult> {
    return streamCompat(this.ai, await this.buildCallSettings(options), options);
  }

  abstract supportsTools(model: string): boolean;
  abstract supportsStreaming(model: string): boolean;
  abstract getModels(): Promise<string[]>;
}
