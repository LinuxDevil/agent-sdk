/**
 * The renderer behind the SecretCard (AA17): a `requestSecret` tool part
 * draws the secure form while it waits for an answer and a one-line
 * outcome once it settles. A busy part (still executing, no output yet)
 * and any real failure fall back to the quiet `ActivityLine`
 * (`undefined`); a draft-review bounce still renders nothing upstream.
 *
 * `AuthorPanel.tsx` imports this module once for its side effect: the
 * registration at the bottom.
 */
import type { ReactNode } from 'react';
import type { AuthorToolPart, RequestSecretOutput } from '../../shared/authorWire';
import { SecretCard } from './SecretCard';
import { registerToolRenderer, type ToolRenderContext } from './toolRenderers';

/**
 * Whether the card owns this part's render: a `pending` part holding a
 * `status:'pending'` output (the form) or any settled outcome the card
 * knows (`saved`/`exists`/`DECLINED`). Everything else - busy, failed,
 * malformed - keeps the activity line.
 */
function owns(part: AuthorToolPart): boolean {
  const output = part.output as RequestSecretOutput | undefined;
  if (part.state === 'pending') return output?.ok === true && output.status === 'pending';
  if (output === undefined) return false;
  if (output.ok === true) return output.status === 'saved' || output.status === 'exists';
  return output.code === 'DECLINED';
}

/** The part renders through the SecretCard, or not at all. */
function renderSecret(part: AuthorToolPart, ctx: ToolRenderContext): ReactNode | undefined {
  if (!owns(part)) return undefined;
  return <SecretCard part={part} chat={ctx.chat} />;
}

registerToolRenderer('requestSecret', renderSecret);
