/**
 * Structural types for the slice of `@earendil-works/pi-ai` the `pi`
 * provider uses (H2). They are deliberately declared here instead of
 * `import type`-ing pi: `pi-ai` is an optional peer, so no `.d.ts` this
 * package ships may name it - a consumer without the peer installed would
 * fail typecheck otherwise. The declarations mirror pi's own
 * (`dist/types.d.ts`, `dist/compat.d.ts`, `dist/providers/all.d.ts`); a
 * field pi adds is simply invisible to us, one it removes breaks our
 * typecheck of the test suite that exercises it.
 */

/** pi `TextContent`. */
export interface PiTextContent {
  type: 'text';
  text: string;
  textSignature?: string;
}

/** pi `ThinkingContent`; `thinkingSignature` also carries redacted blocks' opaque payload. */
export interface PiThinkingContent {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

/** pi `ImageContent`: `data` is base64 - pi's adapters never send a URL. */
export interface PiImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/** pi `ToolCall` content part of an assistant message. */
export interface PiToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

/** pi `Usage` (`cost.*` in USD, computed from the catalog prices). */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of `output` spent on hidden reasoning, when the provider reports it. */
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type PiStopReason = 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred';

export interface PiSystemMessage {
  role: 'system';
  content: string;
  timestamp: number;
}

export interface PiUserMessage {
  role: 'user';
  content: string | Array<PiTextContent | PiImageContent>;
  timestamp: number;
}

/** pi `AssistantMessage`; history entries only read `content`, the rest is required structurally. */
export interface PiAssistantMessage {
  role: 'assistant';
  content: Array<PiTextContent | PiThinkingContent | PiToolCallContent>;
  api: string;
  provider: string;
  model: string;
  usage: PiUsage;
  stopReason: PiStopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface PiToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: Array<PiTextContent | PiImageContent>;
  isError: boolean;
  timestamp: number;
}

export type PiMessage = PiSystemMessage | PiUserMessage | PiAssistantMessage | PiToolResultMessage;

/** pi catalog `Model` (the chat fields the provider reads). */
export interface PiModel {
  id: string;
  name: string;
  /** pi api id, e.g. 'openai-completions' - selects pi's wire adapter. */
  api: string;
  /** pi provider id, e.g. 'openrouter' - selects the env credential. */
  provider: string;
  baseUrl: string;
  input: readonly string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

/** pi `Tool`: `parameters` is TypeBox, which plain JSON Schema satisfies. */
export interface PiTool {
  name: string;
  description: string;
  parameters: unknown;
}

/** pi `Context`, the `stream()`/`complete()` input (pi normalizes it itself). */
export interface PiContext {
  systemPrompt?: string;
  messages: PiMessage[];
  tools?: PiTool[];
}

/**
 * pi `AssistantMessageEvent`, with only the fields the adapter reads.
 * The event union's other members (`partial`, `contentIndex`, ...) are kept
 * loose: they are pi-internal snapshots, not part of our contract.
 */
export interface PiStreamEvent {
  type:
    | 'start'
    | 'text_start'
    | 'text_delta'
    | 'text_end'
    | 'thinking_start'
    | 'thinking_delta'
    | 'thinking_end'
    | 'toolcall_start'
    | 'toolcall_delta'
    | 'toolcall_end'
    | 'done'
    | 'error';
  contentIndex?: number;
  delta?: string;
  content?: string;
  toolCall?: PiToolCallContent;
  reason?: PiStopReason;
  message?: PiAssistantMessage;
  error?: PiAssistantMessage;
  /** The live response-so-far; `content[contentIndex]` is the block an *_end event closed. */
  partial?: PiAssistantMessage;
}

/** pi `AssistantMessageEventStream`: an async iterable that also resolves the final message. */
export interface PiEventStream extends AsyncIterable<PiStreamEvent> {
  result(): Promise<PiAssistantMessage>;
}

/**
 * pi `SimpleStreamOptions`, the fields the adapter sets. The `streamSimple`
 * dispatch maps `reasoning`/`thinkingBudgets`/`toolChoice` onto each api's
 * own option names (openai `reasoning_effort`, anthropic thinking, ...),
 * which the raw `stream()` path does not - hence Simple.
 */
export interface PiStreamOptions {
  signal?: AbortSignal;
  apiKey?: string;
  headers?: Record<string, string | null>;
  /** pi's own retry layer; the adapter pins it (0 by convention, Lousho's withRetry() owns retries). */
  maxRetries?: number;
  maxRetryDelayMs?: number;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  /** pi `ToolChoice`: 'auto' | 'none'. A 'required'/named choice rides `samplingParams.tool_choice`. */
  toolChoice?: 'auto' | 'none';
  /** pi `ThinkingLevel` ('minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'); adapters map it. */
  reasoning?: string;
  thinkingBudgets?: { minimal?: number; low?: number; medium?: number; high?: number };
  /** OpenAI-compatible request-body extras (`top_p`, `stop`, `tool_choice`, ...); other apis ignore it. */
  samplingParams?: Record<string, unknown>;
  sessionId?: string;
}

/** The `@earendil-works/pi-ai/compat` module, as the adapter uses it. */
export interface PiCompatModule {
  streamSimple(model: PiModel, context: PiContext, options?: PiStreamOptions): PiEventStream;
  completeSimple(model: PiModel, context: PiContext, options?: PiStreamOptions): Promise<PiAssistantMessage>;
  /** pi `getEnvApiKey`: the credential env resolution the request would use (per nested provider). */
  getEnvApiKey(provider: string): string | undefined;
}

/** The `@earendil-works/pi-ai/providers/all` module, as the adapter uses it. */
export interface PiCatalogModule {
  getBuiltinModel(provider: string, modelId: string): PiModel | undefined;
  getBuiltinModels(provider: string): PiModel[];
  getBuiltinProviders(): string[];
}
