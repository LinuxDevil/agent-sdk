/**
 * Helpers for multimodal message content (LOU-V11).
 */

import type { Message } from './llm';

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
