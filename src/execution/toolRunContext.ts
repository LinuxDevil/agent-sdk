/**
 * The one builder of the context a tool's `execute(args, ctx)` receives
 * (LOU-U15). Every path that runs a tool - the main loop, resume after an
 * approval, the sandbox route and FlowExecutor's tool-call node - goes
 * through {@link buildToolRunContext}, so the `ToolExecutionContext` the
 * type promises (`toolCallId`, `messages`, `abortSignal`) are always real.
 */

import { newId } from '../utils/id';
import type { Message } from '../providers';
import type { ToolExecutionContext } from '../types/tool';
import { bindToolCallScope, type ToolCallScope } from './subagentRuntime';
import { readonlyPrincipal } from './runPrincipal';
import type { OAuthTokenStore } from '../oauth/types';
import { getToken, requireAuth } from '../oauth/signIn';

/**
 * @deprecated Use {@link ToolExecutionContext}, the one public execute-context
 * type. Kept as an alias of its fields (all optional, `messages` left out, as
 * before) so existing imports compile and 'ai' `tool()` execute options still
 * fit it.
 */
export type ToolRunContext = Partial<Omit<ToolExecutionContext, 'messages'>>;

/** What {@link buildToolRunContext} builds the context from. */
export interface ToolRunInput extends Pick<ToolRunContext, 'toolCallId' | 'sessionId' | 'onDelegatedUsage' | 'approval' | 'principal'> {
  /** The run's transcript. The tool gets the part before the model turn that made this call. */
  messages?: readonly Message[];
  /** The run's cancellation signal; the tool gets it as `abortSignal`. */
  signal?: AbortSignal;
  /** LOU-Y1: lets a delegate/`task` tool's sub-agent inherit from this run. */
  scope?: ToolCallScope;
  /** N9b: where `ctx.getToken()` reads OAuth tokens (the agent's `store.tokens`). */
  tokens?: OAuthTokenStore;
  /** N9b: collects the tokens `ctx.getToken()` handed out during this call (see redactHandedOutTokens()). */
  handedOut?: Set<string>;
  /**
   * N13b: told every snapshot a generator `execute` yields (a `tool.partial`),
   * after the same token redaction as the result. Not part of the tool's context.
   */
  onPartial?: (output: unknown) => void;
}

/**
 * A read-only copy of what the model had seen when it made `toolCallId`'s
 * call: the transcript without the system prompt and without the assistant
 * turn that made the call (or anything after it) - the same meaning
 * `ToolExecutionContext.messages` has (as in the 'ai' SDK).
 */
function transcriptBefore(messages: readonly Message[], toolCallId: string): readonly Message[] {
  const turn = messages.findIndex((m) => m.toolCalls?.some((call) => call.id === toolCallId));
  const before = turn < 0 ? messages : messages.slice(0, turn);
  return Object.freeze(before.filter((m) => m.role !== 'system').map((m) => Object.freeze({ ...m })));
}

/**
 * The context for one tool call: `{ toolCallId, messages, abortSignal }`
 * plus the optional `sessionId` and `onDelegatedUsage`. `toolCallId` falls back
 * to a generated id for callers with no model turn behind the call. N10b: the
 * run's `principal` and the approver (`approval.by`) are frozen here.
 */
export function buildToolRunContext(input: ToolRunInput): ToolExecutionContext {
  const toolCallId = input.toolCallId ?? newId('call');
  const principal = readonlyPrincipal(input.principal);
  const ctx = {
    toolCallId,
    messages: transcriptBefore(input.messages ?? [], toolCallId),
    abortSignal: input.signal,
    onDelegatedUsage: input.onDelegatedUsage,
    ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
    ...(principal && { principal }),
    ...(input.approval && { approval: approvalOf(input.approval) }),
  } as ToolExecutionContext;
  // N9b: methods, not data - kept out of the enumerable fields a tool may log or spread.
  const access = { tokens: input.tokens, principal, handedOut: input.handedOut };
  Object.defineProperties(ctx, {
    getToken: { value: (provider: Parameters<ToolExecutionContext['getToken']>[0]) => getToken(provider, access) },
    requireAuth: { value: (provider: Parameters<ToolExecutionContext['requireAuth']>[0]) => requireAuth(provider, access) },
  });
  bindToolCallScope(ctx, input.scope);
  return ctx;
}

/** The decision a tool sees, with its approver frozen (N10b). */
function approvalOf({ id, note, by }: NonNullable<ToolExecutionContext['approval']>): NonNullable<ToolExecutionContext['approval']> {
  const approver = readonlyPrincipal(by);
  return Object.freeze({ ...(id !== undefined && { id }), ...(note !== undefined && { note }), ...(approver && { by: approver }) });
}
