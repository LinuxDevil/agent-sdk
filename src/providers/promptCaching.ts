/**
 * Eve PROV-F4: Anthropic prompt caching. Anthropic caches a request prefix
 * only up to a `cache_control` breakpoint the request marks; OpenAI and most
 * others cache automatically. With `promptCaching: 'auto'` (the default) the
 * built-in Anthropic and OpenRouter providers mark, for Anthropic-family
 * models, the system prompt, the last tool definition and the last user
 * (or tool-result) turn - three of the four breakpoints Anthropic allows.
 */

import type { AiSdkMessage } from './aiSdkCompat';

/**
 * `'auto'` (the default) places Anthropic cache breakpoints for
 * Anthropic-family models (also through OpenRouter); `false` sends none.
 */
export type PromptCachingOption = 'auto' | false;

/** Anthropic's 5-minute cache breakpoint. */
const EPHEMERAL = { type: 'ephemeral' } as const;

/** The `providerOptions` that mark an AI SDK message or tool as a cache breakpoint (`@ai-sdk/anthropic`). */
export const ANTHROPIC_CACHE_BREAKPOINT = { anthropic: { cacheControl: EPHEMERAL } } as const;

/** Whether `modelId` is a Claude model (`claude-*`, `anthropic/claude-*`, `anthropic/...`). */
export function isAnthropicModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.startsWith('anthropic/') || id.includes('claude');
}

/** Whether a call to `modelId` gets cache breakpoints under `option`. */
export function cachesPrompt(modelId: string, option: PromptCachingOption | undefined): boolean {
  return option !== false && isAnthropicModel(modelId);
}

/** The indexes of the last system message and of the last message when it is a user or tool turn. */
function breakpointIndexes(roles: readonly string[], lastRoles: readonly string[]): number[] {
  const indexes = new Set<number>();
  const system = roles.lastIndexOf('system');
  if (system >= 0) indexes.add(system);
  const last = roles.length - 1;
  if (last >= 0 && lastRoles.includes(roles[last])) indexes.add(last);
  return [...indexes];
}

/**
 * `messages` with the AI SDK's Anthropic cache breakpoint on the last system
 * message and on the last message when it is a user or tool turn (the
 * conversation so far is then cached for the next step of the run).
 */
export function withMessageBreakpoints(messages: AiSdkMessage[]): AiSdkMessage[] {
  const marked = breakpointIndexes(
    messages.map((message) => message.role),
    ['user', 'tool']
  );
  if (marked.length === 0) return messages;
  return messages.map((message, index) => {
    if (!marked.includes(index)) return message;
    const own = (message as { providerOptions?: Record<string, Record<string, unknown>> }).providerOptions;
    return { ...message, providerOptions: { ...own, anthropic: { ...own?.anthropic, cacheControl: EPHEMERAL } } };
  });
}

/** An OpenAI-format message content with `cache_control` on its last non-empty text part; `undefined` when it has none. */
function markedContent(content: unknown): unknown[] | undefined {
  const parts: unknown[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? [...(content as unknown[])] : [];
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index] as { type?: unknown; text?: unknown };
    if (part?.type === 'text' && typeof part.text === 'string' && part.text !== '') {
      parts[index] = { ...part, cache_control: EPHEMERAL };
      return parts;
    }
  }
  return undefined;
}

/**
 * An OpenRouter (OpenAI chat format) request body with Anthropic
 * `cache_control` breakpoints: on the last system message, the last tool
 * definition, and the last message when it is a user turn. OpenRouter passes
 * them on to Anthropic.
 */
export function withBodyBreakpoints(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (Array.isArray(body.messages)) {
    const messages = body.messages as Array<{ role?: unknown; content?: unknown }>;
    const marked = breakpointIndexes(
      messages.map((message) => String(message?.role)),
      ['user']
    );
    out.messages = messages.map((message, index) => {
      const content = marked.includes(index) ? markedContent(message.content) : undefined;
      return content ? { ...message, content } : message;
    });
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = [...(body.tools as Array<Record<string, unknown>>)];
    // The last function tool: a server tool (`openrouter:web_search`) after it is not sent to Anthropic as a definition.
    const last = tools.map((tool) => tool?.type).lastIndexOf('function');
    if (last >= 0) tools[last] = { ...tools[last], cache_control: EPHEMERAL };
    out.tools = tools;
  }
  return out;
}
