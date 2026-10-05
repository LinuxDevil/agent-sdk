/**
 * Lousho `Message[]` -> pi `Message[]` (`Context.messages`), the inverse of
 * the result mapping in PiProvider.
 *
 * The conventions mirror `toCoreMessages()`/`toToolResultMessage()` in the
 * 'ai'-SDK adapter: assistant tool-call turns become one assistant message
 * with `toolCall` parts (arguments decoded from our JSON string), and each
 * `tool` message becomes a `toolResult` linked to its call by id. pi has no
 * file part and its `image` is base64-only, so `file` parts and `http(s)`
 * images degrade to a text note, the same fallback the 'ai' providers use.
 */

import type { ContentPart, ImageContentPart, Message, ReasoningBlock, ToolCall } from '../llm';
import { textOf } from '../content';
import type {
  PiAssistantMessage,
  PiImageContent,
  PiMessage,
  PiModel,
  PiTextContent,
  PiThinkingContent,
  PiToolCallContent,
  PiToolResultMessage,
} from './piTypes';

/** `provider:what` pairs already warned about (one console.warn each). */
const warnedFallbacks = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedFallbacks.has(key)) return;
  warnedFallbacks.add(key);
  console.warn(message);
}

/** Uint8Array -> base64 without `Buffer` (the worker bundle has no node: imports). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** UTF-8 text -> base64 without `Buffer`. */
function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return bytesToBase64(bytes);
}

/**
 * A Lousho `image` part as pi `ImageContent`: `data:` URLs and raw bytes map
 * directly; `http(s)` URLs cannot (pi's adapters send `data` as base64
 * inline only), so they degrade to a text note with a one-time warning -
 * the same fallback `file` parts get.
 */
function imageToPi(part: ImageContentPart): PiImageContent | PiTextContent {
  const { image, mimeType } = part;
  if (typeof image === 'string') {
    const dataUrl = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(image);
    if (dataUrl) {
      return {
        type: 'image',
        mimeType: dataUrl[1] || 'application/octet-stream',
        data: dataUrl[3] ? (dataUrl[2] ? dataUrl[3] : textToBase64(decodeURIComponent(dataUrl[3]))) : '',
      };
    }
    if (/^https?:\/\//i.test(image)) {
      warnOnce('pi:image-url', `[lousho] The pi provider cannot send image URLs; ${image.slice(0, 80)} is sent as a text note.`);
      return { type: 'text', text: `[image ${image} not sent]` };
    }
    // A bare string is assumed to already be base64 data.
    return { type: 'image', data: image, mimeType: mimeType ?? 'image/png' };
  }
  return { type: 'image', data: bytesToBase64(image), mimeType: mimeType ?? 'image/png' };
}

/** A user/tool `content` part: text and images map; files degrade to a text note. */
function userPartToPi(part: ContentPart): PiTextContent | PiImageContent {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image') return imageToPi(part);
  warnOnce(`pi:file:${part.mimeType}`, `[lousho] The pi provider cannot send ${part.mimeType} file parts; they are sent as a text note.`);
  return { type: 'text', text: `[file ${part.filename ?? 'attachment'} (${part.mimeType}) not sent]` };
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

/** Our `ReasoningBlock` back as a pi thinking block (signature / redacted payload preserved). */
function reasoningToPi(block: ReasoningBlock): PiThinkingContent {
  if (block.redactedData !== undefined) return { type: 'thinking', thinking: '', thinkingSignature: block.redactedData, redacted: true };
  return { type: 'thinking', thinking: block.text, ...(block.signature !== undefined && { thinkingSignature: block.signature }) };
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Our `ToolCall` (JSON-string arguments) as a pi toolCall content part. */
function piToolCall(call: ToolCall): PiToolCallContent {
  const args = parseJsonOr(call.function.arguments, {});
  return {
    type: 'toolCall',
    id: call.id,
    name: call.function.name,
    arguments: (args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>,
  };
}

/**
 * A Lousho `assistant` message as pi's `AssistantMessage`: reasoning blocks
 * (LOU-V13) become thinking parts first (so Anthropic can replay them), then
 * the text, then one `toolCall` part per call. pi requires api/model/usage
 * structurally; history reads only `content`, so they carry placeholders.
 */
function assistantToPi(msg: Message, model: PiModel): PiAssistantMessage {
  const content: Array<PiThinkingContent | PiTextContent | PiToolCallContent> = [];
  for (const block of msg.reasoning ?? []) content.push(reasoningToPi(block));
  const text = textOf(msg);
  if (text) content.push({ type: 'text', text });
  for (const call of msg.toolCalls ?? []) content.push(piToolCall(call));
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: msg.toolCalls?.length ? 'toolUse' : 'stop',
    timestamp: 0,
  };
}

/**
 * A Lousho `tool` message as pi `ToolResultMessage`, linked by toolCallId.
 * The result text is sent verbatim (usually JSON the provider re-reads);
 * `isError` forwards our flag.
 */
function toolResultToPi(msg: Message, toolNames: Map<string, string>): PiToolResultMessage {
  const toolCallId = msg.toolCallId ?? '';
  const content = Array.isArray(msg.content)
    ? msg.content.map(userPartToPi)
    : [{ type: 'text' as const, text: String(msg.content ?? '') }];
  return {
    role: 'toolResult',
    toolCallId,
    toolName: msg.toolName ?? msg.name ?? toolNames.get(toolCallId) ?? 'unknown',
    content,
    isError: msg.isError === true,
    timestamp: 0,
  };
}

/**
 * Our message list as pi `Context` fields: a leading `system` message becomes
 * `systemPrompt` (pi folds it into its own leading system message together
 * with `Context.tools`); everything else maps in place. Returns both fields
 * so the provider can build `{ systemPrompt, messages, tools }`.
 */
export function toPiContext(messages: Message[], model: PiModel): { systemPrompt?: string; messages: PiMessage[] } {
  const toolNames = new Map<string, string>();
  const out: PiMessage[] = [];
  let systemPrompt: string | undefined;
  let first = true;
  for (const msg of messages) {
    if (msg.role === 'system') {
      if (first) systemPrompt = textOf(msg);
      else out.push({ role: 'system', content: textOf(msg), timestamp: 0 });
      first = false;
      continue;
    }
    first = false;
    if (msg.role === 'user') {
      out.push({
        role: 'user',
        content: Array.isArray(msg.content) ? msg.content.map(userPartToPi) : msg.content,
        timestamp: 0,
      });
    } else if (msg.role === 'assistant') {
      const converted = assistantToPi(msg, model);
      for (const call of msg.toolCalls ?? []) toolNames.set(call.id, call.function.name);
      out.push(converted);
    } else {
      out.push(toolResultToPi(msg, toolNames));
    }
  }
  return { systemPrompt, messages: out };
}
