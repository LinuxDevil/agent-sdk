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
import type { LanguageModel } from 'ai';
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
  TextContentPart,
  ReasoningBlock,
} from './llm';
import { reasoningProviderOptions } from './reasoning';
import { hostedToolUnsupported, type HostedTool, type HostedToolType } from '../tools/hosted';
import { textOf } from './content';
import { schemaToJsonSchema } from '../utils/zodCompat';
import { type AiSdkMessage, type AiSdkModule, aiMajorOf, compatGenerateText, streamCompat } from './aiSdkCompat';

// The `ai` v4 request shapes built here, as our own structural types (LOU-D28a):
// `ai` v6/v7 do not export the v4 ones, and aiSdkCompat maps these to v6/v7.
// Text, image and file parts are already v4-shaped as our `ContentPart`s.
type ToolCallPart = { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown };
type ToolResultPart = { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; isError?: boolean };
type ReasoningPart = { type: 'reasoning'; text: string; signature?: string } | { type: 'redacted-reasoning'; data: string };
/** A v4 `tool()` (the identity function in v4): `parameters` and a placeholder `execute`. */
type AiSdkTool = { description: string; parameters: unknown; execute: () => Promise<null> };

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
function toAssistantToolCallMessage(msg: Message, toolCalls: ToolCall[], support: PartSupport): AiSdkMessage {
  const text = textOf(msg);
  const reasoning = support.reasoning ? (msg.reasoning ?? []).map(toReasoningPart) : [];
  const parts: Array<ReasoningPart | TextContentPart | ToolCallPart> = [...reasoning, ...(text ? [{ type: 'text' as const, text }] : [])];
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

/** LOU-V13: a reasoning block as the v4 part Anthropic replays (aiSdkCompat maps it for v6/v7). */
function toReasoningPart(block: ReasoningBlock): ReasoningPart {
  if (block.redactedData !== undefined) return { type: 'redacted-reasoning', data: block.redactedData };
  return { type: 'reasoning', text: block.text, ...(block.signature !== undefined && { signature: block.signature }) };
}

/**
 * A tool message becomes a `tool-result` part linked to its call. The
 * result is decoded from JSON (providers JSON-encode it again on the wire,
 * so passing our encoded string would double-encode it); non-JSON text and
 * non-string content are passed through unchanged.
 */
function toToolResultMessage(msg: Message, toolNames: Map<string, string>): AiSdkMessage {
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
  /** Whether a file part of this media type is sent; `false`: it becomes a text note, with a one-time warning. */
  files: (mimeType: string) => boolean;
  /** The `ai` major in use, named in the warning. */
  aiMajor: number;
  /** LOU-V13: send an assistant turn's `reasoning` blocks back (Anthropic). */
  reasoning?: boolean;
}

/** `provider:mimeType` pairs already warned about turning a file part into text. */
const warnedFileParts = new Set<string>();

/** A user content part as the 'ai' v4 `TextPart` / `ImagePart` / `FilePart`. */
function toUserPart(part: ContentPart, support: PartSupport): ContentPart {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image') {
    return { type: 'image', image: part.image, ...(part.mimeType ? { mimeType: part.mimeType } : {}) };
  }
  if (support.files(part.mimeType)) {
    return { type: 'file', data: part.data, mimeType: part.mimeType, ...(part.filename ? { filename: part.filename } : {}) };
  }
  const warnKey = `${support.provider}:${part.mimeType}`;
  if (!warnedFileParts.has(warnKey)) {
    warnedFileParts.add(warnKey);
    console.warn(
      `[lousho] The ${support.provider} provider cannot send ${part.mimeType} file parts on ai ${support.aiMajor}; they are sent as a text note.`
    );
  }
  return { type: 'text', text: `[file ${part.filename ?? 'attachment'} (${part.mimeType}) not sent]` };
}

/**
 * Convert our Message history to 'ai' SDK CoreMessages, preserving the
 * assistant's tool-call turns and linking each tool result to its call by
 * id, as every provider (OpenAI, Anthropic, Ollama, OpenRouter) requires.
 * Content parts (LOU-V11) are sent on user messages; other roles get their text.
 */
function toCoreMessages(messages: Message[], support: PartSupport): AiSdkMessage[] {
  const toolNames = new Map<string, string>();
  return messages.map((msg): AiSdkMessage => {
    if (msg.role === 'tool') {
      return toToolResultMessage(msg, toolNames);
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) toolNames.set(tc.id, tc.function.name);
      return toAssistantToolCallMessage(msg, msg.toolCalls, support);
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      return { role: 'user', content: msg.content.map((part) => toUserPart(part, support)) };
    }
    return { role: msg.role, content: textOf(msg) };
  });
}

/**
 * A tool's `parameters` for `ai` v4, whose own converter only reads zod 3:
 * a zod 4 / Standard JSON Schema goes as its JSON Schema (LOU-D29).
 */
function v4Parameters(ai: AiSdkModule, parameters: unknown): unknown {
  const json = schemaToJsonSchema(parameters);
  return json ? ai.jsonSchema(json as never) : parameters;
}

/**
 * Convert our tool definitions to 'ai' SDK tools, or `undefined` when there
 * are none (the 'ai' SDK treats an empty tool set differently from no tools).
 */
function convertTools(ai: AiSdkModule, toolDefs: ToolDefinition[] | undefined): Record<string, AiSdkTool> | undefined {
  const tools: Record<string, AiSdkTool> = {};
  for (const toolDef of toolDefs ?? []) {
    tools[toolDef.function.name] = {
      description: toolDef.function.description,
      parameters: v4Parameters(ai, toolDef.function.parameters),
      // A placeholder: the actual execution happens in AgentExecutor.
      execute: async () => null,
    };
  }
  return Object.keys(tools).length > 0 ? tools : undefined;
}

/** An `ai` v4 `Output` spec, structurally (v6/v7 get aiSdkCompat's own). */
interface AiSdkOutput {
  type: 'object';
  responseFormat(options: { model: unknown }): { type: 'json'; schema?: Record<string, unknown> };
  injectIntoSystemPrompt(options: { system: string | undefined }): string | undefined;
  parsePartial(options: { text: string }): { partial: string };
  parseOutput(options: { text: string }): string;
}

/** Whether a v4 language model object reports `supportsStructuredOutputs`. */
function supportsStructuredOutputs(model: unknown): boolean {
  return typeof model === 'object' && model !== null && Boolean((model as { supportsStructuredOutputs?: unknown }).supportsStructuredOutputs);
}

/**
 * LOU-V4: `responseFormat` as an 'ai' SDK output spec - JSON mode, with the
 * schema only for models that support structured outputs (as
 * `Output.object()` does). Unlike `Output.object()` it leaves the prompt and
 * the reply text alone: AgentExecutor instructs the model and validates.
 */
function toOutput(format: GenerateOptions['responseFormat']): AiSdkOutput | undefined {
  if (format?.type !== 'json') return undefined;
  return {
    type: 'object',
    responseFormat: ({ model }) => ({
      type: 'json',
      schema: supportsStructuredOutputs(model) ? format.schema : undefined,
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
  protected abstract createModel(modelId: string, options?: GenerateOptions): LanguageModel | Promise<LanguageModel>;

  /**
   * Whether this provider's 'ai' SDK model takes `file` parts (LOU-V11). The
   * built-in providers' pinned peers (`@ai-sdk/*` 0.0.x, `ollama-ai-provider`)
   * do not, so their file parts become a text note; image parts are sent.
   * `true` sends every file type; `fileMediaTypes()` opts in single types.
   */
  protected readonly acceptsFileParts: boolean = false;

  /** The file media types sent as `file` parts (others become a text note). None by default. */
  protected fileMediaTypes(): readonly string[] {
    return [];
  }

  /** LOU-V13: whether assistant turns send their signed `reasoning` blocks back (Anthropic requires it with tools). */
  protected readonly replaysReasoning: boolean = false;

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
    const sendable = this.fileMediaTypes();
    return toCoreMessages(messages, {
      provider: this.name,
      files: (mimeType) => this.acceptsFileParts || sendable.includes(mimeType.split(';')[0].trim().toLowerCase()),
      aiMajor: aiMajorOf(this.ai),
      reasoning: this.replaysReasoning,
    });
  }

  /** LOU-V13: the `providerOptions` that carry the call's `reasoning` for this provider's model. */
  protected reasoningOptions(modelId: string, options: GenerateOptions): Record<string, unknown> | undefined {
    return reasoningProviderOptions(this.name, modelId, options.reasoning);
  }

  /**
   * N1a: whether this provider can send a hosted tool of `type`. The base
   * supports only `hostedTool()` pass-through, on `ai` 6 or 7; providers with
   * built-in hosted tools (OpenAI) override it.
   */
  supportsHostedTool(type: HostedToolType | 'custom'): boolean {
    return type === 'custom' && aiMajorOf(this.ai) >= 6;
  }

  /**
   * N1a: the AI SDK tool objects for `tools`, keyed by name, sent with the
   * function tools. The base passes `hostedTool()` objects through on `ai` 6
   * or 7 and throws `LOUSHO_HOSTED_TOOL_UNSUPPORTED` for everything else;
   * a provider with built-in hosted tools maps them (see OpenAIProvider).
   */
  protected async hostedToolsFor(tools: readonly HostedTool[], _modelId: string): Promise<Record<string, unknown>> {
    return this.splitHostedTools(tools).passed;
  }

  /**
   * N1a/N1b: for providers with built-in hosted tools: the `hostedTool()`
   * objects as tools (`passed`, which is where `ai` 4 and a provider without
   * the tool are refused) and the helpers' tools for the provider to map (`builtIn`).
   */
  protected splitHostedTools(tools: readonly HostedTool[]): { passed: Record<string, unknown>; builtIn: HostedTool[] } {
    const major = aiMajorOf(this.ai);
    const passed: Record<string, unknown> = {};
    for (const tool of tools) {
      if (major < 6) throw hostedToolUnsupported(this.name, tool, `hosted tools need ai 6 or 7, and ai ${major} is installed`);
      if (tool.type !== 'custom') {
        if (this.mapsHostedTools) continue;
        throw hostedToolUnsupported(this.name, tool, `this provider has no built-in ${tool.type} tool`);
      }
      passed[tool.name] = tool.aiSdkTool;
    }
    return { passed, builtIn: tools.filter((tool) => tool.type !== 'custom') };
  }

  /** Set by providers whose hostedToolsFor() maps the helpers (OpenAI, Anthropic). */
  protected readonly mapsHostedTools: boolean = false;

  /** The call settings shared by generate() and stream(). */
  private async buildCallSettings(options: GenerateOptions) {
    const modelId = options.model || this.defaultModel;
    const hostedTools = options.hostedTools?.length ? await this.hostedToolsFor(options.hostedTools, modelId) : undefined;
    return {
      ...(hostedTools && { hostedTools }),
      model: await this.createModel(modelId, options),
      messages: this.convertMessages(options.messages),
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      frequencyPenalty: options.frequencyPenalty,
      presencePenalty: options.presencePenalty,
      seed: options.seed,
      tools: convertTools(this.ai, options.tools),
      maxSteps: 1, // Single step - tool execution happens in AgentExecutor
      // The 'ai' SDK's own retries (its default is 2). createAgent() resolves
      // providers with 0 and retries in its withRetry() wrapper instead.
      maxRetries: this.config.maxRetries ?? 2,
      abortSignal: options.signal,
      experimental_output: toOutput(options.responseFormat),
      providerOptions: this.reasoningOptions(modelId, options),
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
