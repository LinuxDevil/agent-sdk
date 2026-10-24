import type { PlaygroundMessage } from './types';

/** The server's placeholder pattern (server/playground.ts `substituteVariables`). */
const VARIABLE = /\{([A-Za-z_][\w.-]*)\}/g;

/** Every `{name}` placeholder across `messages`, de-duplicated, in first-seen order. */
export function detectVariables(messages: readonly PlaygroundMessage[]): string[] {
  const seen = new Set<string>();
  for (const { content } of messages) {
    for (const match of content.matchAll(VARIABLE)) seen.add(match[1]!);
  }
  return [...seen];
}
