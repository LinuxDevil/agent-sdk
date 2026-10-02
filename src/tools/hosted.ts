/**
 * N1a: hosted provider tools - tools the model provider runs inside the
 * request (OpenAI web search, code interpreter, file search), passed in the
 * agent's `tools` next to local tools. The SDK never executes them: it sends
 * them with each model call and reports the calls the provider made.
 * See docs/hosted-tools.md.
 */

import { ConfigurationError } from '../execution/errors';

/** The hosted tools with a helper; `'custom'` is any AI SDK provider tool passed with {@link hostedTool}. */
export type HostedToolType = 'web_search' | 'code_interpreter' | 'file_search';

/**
 * A tool the model provider runs, created with {@link webSearch},
 * {@link codeInterpreter}, {@link fileSearch} or {@link hostedTool}. Put it in
 * `createAgent({ tools })` like a local tool.
 */
export interface HostedTool {
  readonly kind: 'hosted-tool';
  /** The name the model and events use: the type, or the key given to hostedTool(). */
  readonly name: string;
  readonly type: HostedToolType | 'custom';
  readonly options: Record<string, unknown>;
  /** For hostedTool(): the AI SDK provider tool object, passed through as it is. */
  readonly aiSdkTool?: unknown;
}

/** Options of {@link webSearch}. Each provider uses the ones it supports and warns once about the rest. */
export interface WebSearchOptions {
  /** Most searches per request (Anthropic). */
  maxUses?: number;
  /** Only search these domains. */
  allowedDomains?: string[];
  /** Never search these domains (Anthropic). */
  blockedDomains?: string[];
  /** How much search context the model gets (OpenAI). */
  searchContextSize?: 'low' | 'medium' | 'high';
  /** Approximate user location to localize results. */
  userLocation?: { country?: string; city?: string; region?: string; timezone?: string };
}

/** Options of {@link codeInterpreter}. */
export interface CodeInterpreterOptions {
  /** An existing container id (OpenAI); default: the provider creates one. */
  container?: string;
}

/** Options of {@link fileSearch}. */
export interface FileSearchOptions {
  /** The vector stores to search (OpenAI). */
  vectorStoreIds: string[];
  /** Most results per search. */
  maxResults?: number;
}

/** The options without the keys left `undefined`. */
function defined(options: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

function hosted(type: HostedToolType, options: object): HostedTool {
  return Object.freeze({ kind: 'hosted-tool', name: type, type, options: defined(options) });
}

/**
 * The provider's own web search, run by the provider inside the model call.
 *
 * @example
 * ```ts
 * const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: [webSearch({ searchContextSize: 'low' })] });
 * ```
 */
export function webSearch(options: WebSearchOptions = {}): HostedTool {
  return hosted('web_search', options);
}

/**
 * The provider's code interpreter (a sandboxed Python container the provider runs).
 *
 * @example
 * ```ts
 * const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: [codeInterpreter()] });
 * ```
 */
export function codeInterpreter(options: CodeInterpreterOptions = {}): HostedTool {
  return hosted('code_interpreter', options);
}

/**
 * The provider's file search over vector stores you created with the provider.
 *
 * @example
 * ```ts
 * const agent = createAgent({ model: 'openai/gpt-4o-mini', tools: [fileSearch({ vectorStoreIds: ['vs_123'] })] });
 * ```
 */
export function fileSearch(options: FileSearchOptions): HostedTool {
  if (!Array.isArray(options?.vectorStoreIds) || options.vectorStoreIds.length === 0) {
    throw new ConfigurationError('fileSearch() needs `vectorStoreIds`: at least one vector store id.', 'vectorStoreIds');
  }
  return hosted('file_search', options);
}

/**
 * Any AI SDK provider-defined tool (e.g. `anthropic.tools.webFetch_20260318()`), under `name`.
 * It is sent to the model as it is; it needs `ai` 6 or 7 and an AI SDK provider
 * (a built-in one or `fromAiSdk()`).
 *
 * @example
 * ```ts
 * import { openai } from '@ai-sdk/openai';
 * const agent = createAgent({ provider: fromAiSdk(openai('gpt-4o-mini')), tools: [hostedTool('image_generation', openai.tools.imageGeneration())] });
 * ```
 */
export function hostedTool(name: string, aiSdkTool: unknown): HostedTool {
  if (typeof name !== 'string' || name === '') {
    throw new ConfigurationError('hostedTool(name, tool): `name` must be a non-empty string.', 'name');
  }
  if (typeof aiSdkTool !== 'object' || aiSdkTool === null) {
    throw new ConfigurationError(`hostedTool('${name}', tool): \`tool\` must be an AI SDK provider tool object.`, 'tool');
  }
  return Object.freeze({ kind: 'hosted-tool', name, type: 'custom', options: {}, aiSdkTool });
}

/** Whether `value` is a {@link HostedTool}. */
export function isHostedTool(value: unknown): value is HostedTool {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'hosted-tool';
}

/**
 * Throws `LOUSHO_CONFIG_INVALID` when two hosted tools share a name, or a
 * hosted tool has the name of a local tool (`localNames`).
 */
export function assertHostedToolNames(hostedTools: readonly HostedTool[], localNames: Iterable<string>): void {
  const local = new Set(localNames);
  const seen = new Set<string>();
  for (const tool of hostedTools) {
    const clash = seen.has(tool.name) ? 'another hosted tool' : local.has(tool.name) ? 'a local tool' : undefined;
    if (clash) {
      throw new ConfigurationError(
        `Tool name '${tool.name}' is already registered: ${clash} conflicts with hosted tool '${tool.name}' (${tool.type}). ` +
          'Give one of them a different name.',
        'tools'
      );
    }
    seen.add(tool.name);
  }
}

/**
 * The `LOUSHO_HOSTED_TOOL_UNSUPPORTED` error: `provider` cannot send `tool`;
 * `why` says what is missing, the rest what would work.
 */
export function hostedToolUnsupported(provider: string, tool: HostedTool, why: string): ConfigurationError {
  return new ConfigurationError(
    `The '${provider}' provider cannot run hosted tool '${tool.name}' (${tool.type}): ${why}. ` +
      'Hosted tools run on the OpenAI provider (web_search, code_interpreter, file_search) with ai 6 + @ai-sdk/openai 3 or ai 7 + @ai-sdk/openai 4, ' +
      'and hostedTool() passes any AI SDK provider tool through on ai 6 or 7. Leave the tool out of `tools` for this provider. See docs/hosted-tools.md.',
    'tools',
    'LOUSHO_HOSTED_TOOL_UNSUPPORTED'
  );
}
