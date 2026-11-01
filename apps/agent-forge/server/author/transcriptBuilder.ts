/**
 * Folds one turn's `AgentEvent`s into the ordered parts of the
 * `AuthorAssistantMessage` the session store persists at turn end. Pure:
 * the turn runner calls `text`/`toolStart`/`toolDone`/`toolError` as
 * matching events stream by, then `message()` once.
 *
 * Merge rules: consecutive text deltas join into one text part; a text
 * delta after a tool part starts a NEW text part (so the transcript keeps
 * the order the model produced it in). A tool part opens `pending` at
 * `tool.start` and settles `done`, `pending` (a client-answered card like
 * requestSecret) or `error` when its call resolves.
 */
import type { AuthorAssistantMessage, AuthorTextPart, AuthorToolPart } from '../../shared/authorWire';

/** The fields `message()` stamps that the parts don't carry: ids and the turn's outcome. */
export interface AssistantMessageMeta {
  id: string;
  at: string;
  requestId?: string;
  finishReason?: string;
}

export class TranscriptBuilder {
  private readonly parts: Array<AuthorTextPart | AuthorToolPart> = [];
  private readonly openTools = new Map<string, AuthorToolPart>();

  /** A `text.delta`: appends to the current text part or opens a new one after a tool part. */
  text(text: string): void {
    const last = this.parts[this.parts.length - 1];
    if (last !== undefined && last.type === 'text') {
      last.text += text;
      return;
    }
    this.parts.push({ type: 'text', text });
  }

  /** A `tool.start`: opens a tool part pending its result, keyed by the call id. */
  toolStart(toolCallId: string, name: string, input: unknown): void {
    const part: AuthorToolPart = { type: 'tool', toolCallId, name, input, state: 'pending' };
    this.parts.push(part);
    this.openTools.set(toolCallId, part);
  }

  /** A `tool.done`: fills the call's output; `pending` keeps the card open instead of settling it. */
  toolDone(toolCallId: string, output: unknown, pending: boolean): void {
    const part = this.openTools.get(toolCallId);
    if (part === undefined) return;
    part.output = output;
    part.state = pending ? 'pending' : 'done';
  }

  /** A `tool.error`: the call's output is the `{ ok: false, code, error }` payload the runner builds. */
  toolError(toolCallId: string, output: unknown): void {
    const part = this.openTools.get(toolCallId);
    if (part === undefined) return;
    part.output = output;
    part.state = 'error';
  }

  /** The assistant message: every part in order, stamped with the turn's meta. */
  message(meta: AssistantMessageMeta): AuthorAssistantMessage {
    return {
      id: meta.id,
      role: 'assistant',
      parts: [...this.parts],
      at: meta.at,
      ...(meta.requestId !== undefined && { requestId: meta.requestId }),
      ...(meta.finishReason !== undefined && { finishReason: meta.finishReason }),
    };
  }
}
