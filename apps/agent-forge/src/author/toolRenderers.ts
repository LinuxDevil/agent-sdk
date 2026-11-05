import type { ReactNode } from 'react';
import {
  isDraftReviewFailure,
  type AuthorAssistantMessage,
  type AuthorToolPart,
} from '../../shared/authorWire';
import type { AuthorChat } from './AuthorChatContext';

/**
 * What a tool-part renderer needs besides the part itself: the message it
 * belongs to (a proposal card reads sibling parts), the chat actions (a
 * card's Apply button calls `chat.apply`), and whether its turn is still
 * streaming (live parts settle; cards disable their actions until then).
 */
export interface ToolRenderContext {
  message: AuthorAssistantMessage;
  chat: AuthorChat;
  live: boolean;
}

/**
 * A card renderer for one tool name. `null` means "render nothing" (the
 * draft-review bounce); `undefined` means "no card" and the caller falls
 * back to the quiet `ActivityLine`.
 */
export type ToolPartRenderer = (part: AuthorToolPart, ctx: ToolRenderContext) => ReactNode | null | undefined;

const renderers = new Map<string, ToolPartRenderer>();

/**
 * Registers the card one tool name renders. AA16 (proposal) and AA17
 * (success/secret/error/setup) plug in here; this ticket ships the
 * registry itself plus the ActivityLine fallback.
 */
// fallow-ignore-next-line unused-export -- AA16/AA17 register their cards here
export function registerToolRenderer(name: string, renderer: ToolPartRenderer): void {
  renderers.set(name, renderer);
}

/**
 * Renders a tool part through the registry. A draft-review failure always
 * renders nothing - the review pass is internal, so even before AA16's
 * proposal card lands the bounce never shows. An unregistered name (or a
 * renderer returning `undefined`) returns `undefined` so the caller draws
 * the activity line.
 */
export function renderToolPart(part: AuthorToolPart, ctx: ToolRenderContext): ReactNode {
  if (isDraftReviewFailure(part.output)) return null;
  return renderers.get(part.name)?.(part, ctx);
}
