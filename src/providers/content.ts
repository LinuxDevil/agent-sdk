/**
 * Helpers for multimodal message content (LOU-V11).
 */

import type { ContentPart, Message } from './llm';

/**
 * The text of a message (or of its `content`): the string itself, or its
 * text parts concatenated. Image and file parts contribute nothing.
 *
 * @example
 * textOf({ role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'image', image: url }] }); // 'Hi'
 */
export function textOf(message: Pick<Message, 'content'> | Message['content']): string {
  const content = typeof message === 'object' && !Array.isArray(message) ? message.content : message;
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  let text = '';
  for (const part of content) if (part.type === 'text') text += part.text;
  return text;
}

/**
 * What `send()` / `stream()` take (LOU-V12): a string or content parts become
 * one user message; a `Message[]` is passed through as it is.
 *
 * @example
 * agent.send([{ type: 'text', text: 'What is in this photo?' }, { type: 'image', image: url }]);
 */
export type AgentInput = string | ContentPart[] | Message[];

/** `input` as messages: a string or parts become one user message, `Message[]` is returned as it is. */
export function toMessages(input: AgentInput): Message[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  // An empty array has no parts to tell it from messages: it adds nothing either way.
  return isMessages(input) ? input : [{ role: 'user', content: input }];
}

function isMessages(input: ContentPart[] | Message[]): input is Message[] {
  return input.length === 0 || 'role' in input[0]!;
}

/** The user text of `input` (the last user message of a `Message[]`), then an `[image]` / `[file]` marker per non-text part. */
export function describeInput(input: AgentInput): string {
  const content = toMessages(input).filter((m) => m.role === 'user').pop()?.content ?? '';
  if (typeof content === 'string') return content;
  const markers = content.filter((part) => part.type !== 'text').map((part) => `[${part.type}]`);
  return [textOf(content), ...markers].filter(Boolean).join(' ');
}
