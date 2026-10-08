/**
 * Handoffs (N6): `createAgent({ handoffs })` lets an agent hand the whole
 * conversation to another agent, which then answers the user itself and keeps
 * the conversation in later session turns. Unlike a sub-agent, the target is
 * not a tool whose result comes back: the run goes on as the target. See
 * docs/handoffs.md.
 */

import type { Message } from './providers/llm';
import type { StandardSchemaV1 } from './utils/zodCompat';
import type { HandoffInputData } from './execution/handoffRun';
import type { PerRun, SimpleAgent } from './createAgent';

/** Options of {@link handoff}. */
export interface HandoffOptions {
  /** The tool the model calls to hand off. Default `transfer_to_<target name>`. */
  toolName?: string;
  /** The tool's description. Default: the target's `description`. */
  description?: string;
  /**
   * The arguments the model passes with the handoff (a zod schema or any
   * Standard Schema); default `{ reason?: string }`. A call whose arguments do
   * not match gets a tool error, and no handoff happens.
   */
  input?: StandardSchemaV1;
  /**
   * What the target sees; default: everything. `data.messages` includes the
   * handoff's routing note (who was transferred, with the validated
   * arguments) - return them as they are to keep it, or drop or replace it.
   * A kept note is folded into the target's system prompt, so it never sits
   * mid-conversation (chat templates of local-model servers reject a system
   * message that is not the first one). See {@link handoffFilters}.
   */
  inputFilter?: (data: HandoffInputData) => Message[] | Promise<Message[]>;
  /** Called once the handoff is decided, before the target's first model call. */
  onHandoff?: (data: HandoffInputData & { sessionId?: string }) => void | Promise<void>;
  /** Whether the handoff is offered on this run (default `true`); a function is resolved when the run (or the handoff's agent) starts. */
  isEnabled?: PerRun<boolean>;
}

/** A handoff target with its options, as {@link handoff} returns it. */
export interface Handoff {
  readonly kind: 'handoff';
  readonly target: SimpleAgent;
  readonly options: HandoffOptions;
}

/**
 * A handoff to `target` (a `createAgent()` agent with a `name` and a
 * `description`) with options; pass it in `createAgent({ handoffs })`. A bare
 * agent there is the same as `handoff(agent)`.
 *
 * @example
 * ```ts
 * const triage = createAgent({ model: 'openai/gpt-4o-mini', instructions: 'Route the user.', handoffs: [handoff(billing, { inputFilter: handoffFilters.removeToolCalls }), refunds] });
 * ```
 */
export function handoff(target: SimpleAgent, options: HandoffOptions = {}): Handoff {
  return Object.freeze({ kind: 'handoff' as const, target, options: { ...options } });
}

/** Whether `value` is a {@link handoff} result. */
export function isHandoff(value: unknown): value is Handoff {
  return typeof value === 'object' && value !== null && (value as Partial<Handoff>).kind === 'handoff' && 'target' in value;
}

/** Whether `message` still has text once its tool calls are dropped. */
function hasText(message: Message): boolean {
  return typeof message.content === 'string' ? message.content.trim() !== '' : message.content.length > 0;
}

/** Ready-made `inputFilter`s for {@link handoff}. */
export const handoffFilters = {
  /**
   * Drops tool calls and tool results, keeps user and assistant text - and the
   * handoff's routing note, so the target still reads the validated handoff
   * arguments (in its system prompt).
   *
   * @example
   * ```ts
   * handoff(billing, { inputFilter: handoffFilters.removeToolCalls });
   * ```
   */
  removeToolCalls(data: HandoffInputData): Message[] {
    const kept: Message[] = [];
    for (const message of data.messages) {
      if (message.role === 'user') kept.push(message);
      else if (message.role === 'system' && message.metadata?.handoff) kept.push(message);
      else {
        if (message.role !== 'assistant' || !hasText(message)) continue;
        const { toolCalls: _calls, reasoning: _reasoning, ...text } = message;
        kept.push(text);
      }
    }
    return kept;
  },
  /**
   * Keeps only the last user message: the target starts fresh on the request.
   *
   * @example
   * ```ts
   * handoff(refunds, { inputFilter: handoffFilters.lastUserMessage });
   * ```
   */
  lastUserMessage(data: HandoffInputData): Message[] {
    const last = [...data.messages].reverse().find((message) => message.role === 'user');
    return last ? [last] : [];
  },
};
