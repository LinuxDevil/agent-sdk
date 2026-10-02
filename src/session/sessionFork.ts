/**
 * Session history and forks (N3a): the steps of a session's committed
 * transcript, and the transcript a fork from one of them keeps.
 */

import type { Message } from '../providers/llm';
import { textOf } from '../providers/content';
import type { ForkPatch } from '../execution/checkpoint';
import { ConfigurationError } from '../execution/errors';
import { withToolResult } from '../execution/fork';

/** One step of `session.history()`: a model response and the results of its tool calls. */
export interface SessionHistoryStep {
  /** 1-based, across the whole session. */
  step: number;
  /** 0-based turn the step belongs to (a turn starts at a user message). */
  turn: number;
  /** Index in `session.messages` of the step's assistant message. */
  messageIndex: number;
  /** The assistant message's text ('' when it only called tools). */
  text: string;
  toolCalls: Array<{ id: string; name: string; args: unknown; result?: string }>;
}

/** Options of `session.fork()`. */
export interface SessionForkOptions {
  /** Step to fork after (from `history()`); the fork keeps everything up to and including it. `0` keeps nothing. */
  fromStep: number;
  /** The fork's id. Default `<id>-fork-<n>`, the first `n` (from 1) with no transcript in the store. */
  id?: string;
  /** Replaces the result of one tool call in the kept transcript, as `ForkPatch.toolResult` does. */
  patch?: Pick<ForkPatch, 'toolResult'>;
}

/** A step and the index just after its last tool message. */
interface StepSpan {
  step: SessionHistoryStep;
  end: number;
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The steps of `messages`, oldest first. Every user message starts a turn
 * (queued or steered input under `turnPolicy` too, as there is no telling it
 * apart), so a step's `turn` is the 0-based index of the user message it
 * answers: the numbering of workspace rewind (`WorkspaceCheckpoints`).
 * The returned steps share nothing with `messages`.
 */
export function transcriptSteps(messages: readonly Message[]): StepSpan[] {
  const spans: StepSpan[] = [];
  let users = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user') users += 1;
    if (message.role !== 'assistant') return;
    const turn = Math.max(0, users - 1);
    const results = new Map<string, string>();
    let end = index + 1;
    while (end < messages.length && messages[end].role === 'tool') {
      results.set(messages[end].toolCallId ?? '', textOf(messages[end]));
      end += 1;
    }
    const toolCalls = (message.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      args: parseArgs(call.function.arguments),
      ...(results.has(call.id) && { result: results.get(call.id) }),
    }));
    spans.push({ end, step: { step: spans.length + 1, turn, messageIndex: index, text: textOf(message), toolCalls } });
  });
  return spans;
}

/**
 * The transcript a fork of `messages` after `fromStep` keeps: everything up
 * to the step's last tool message, patched, cut to a provider-valid prefix
 * by `validPrefix`. Throws `LOUSHO_SESSION_STEP_NOT_FOUND` for a step that
 * is not in `0..steps`.
 */
export function forkTranscript(
  messages: readonly Message[],
  options: SessionForkOptions,
  sessionId: string,
  validPrefix: (messages: readonly Message[]) => Message[]
): Message[] {
  const { fromStep, patch } = options;
  const steps = transcriptSteps(messages);
  if (!Number.isInteger(fromStep) || fromStep < 0 || fromStep > steps.length) {
    throw new ConfigurationError(
      `fork: session '${sessionId}' has no step ${String(fromStep)}; fromStep must be an integer from 0 to ${steps.length}.`,
      'fromStep',
      'LOUSHO_SESSION_STEP_NOT_FOUND'
    );
  }
  let kept = structuredClone(messages.slice(0, fromStep === 0 ? 0 : steps[fromStep - 1].end));
  if (patch?.toolResult) kept = withToolResult(kept, patch.toolResult);
  return validPrefix(kept);
}
