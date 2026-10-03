/**
 * Resume execution of an agent after a human has decided on a pending
 * tool-call approval.
 */

import { LLMProvider, Message, ToolCall } from '../providers';
import { ToolRegistry } from '../tools';
import { getToolExecute } from '../tools/toolContract';
import { approvalMarker } from '../tools/approvalPolicies';
import type { ToolDescriptor, ToolExecutionContext } from '../types';
import {
  ApprovalDecision,
  ApprovalStore,
  describeApproval,
  ExecutionSnapshot,
  PendingApproval,
  ResolvedApproval,
} from './ApprovalGate';
import { AgentExecutor, ExecuteOptions, ExecutionResult } from './AgentExecutor';
import { observeRun, partialSink, runEventsOf, streamResumed, type AgentRun, type ToolSettled } from './agentRun';
import { Checkpoint, CheckpointStore, RUN_CONFIG_KEY } from './checkpoint';
import { checkAgentDrift, fingerprintOf, type AgentDrift } from './agentFingerprint';
import type { AgentConfig } from '../types';
import { NoopSandbox } from '../security/sandboxCore';
import { executeToolWithSandboxGuard } from './sandboxGuard';
import { HookRegistry } from './hooks';
import { runPreToolHooks, type ToolCallOutcome } from './toolCallExecution';
import { markPropagating, toolErrorMessage } from './propagatingToolError';
import { SDKError } from './errors';
import { toolErrorResult, type ToolErrorResult } from './toolErrors';
import { splitPendingTurn } from './transcript';
import { replaceToolResult, type ToolCallScope } from './subagentRuntime';
import type { RunUsage } from '../models/usage';
import { emptyRunUsage, mergeDelegatedUsage, restoreRunUsage } from './runUsage';
import { planModeRefusal } from './permissions';
import { resumeSubagentCall, type ResumeContext } from './resumeSubagent';
import type { Principal } from '../auth/types';
import { readonlyPrincipal } from './runPrincipal';
import type { OAuthTokenStore } from '../oauth/types';
import { isSignInRequired, settleSignInRequired, signInOwner, signInRequest, SignInPendingError, type SignInRequired } from '../oauth/signIn';
import { newId } from '../utils/id';

/**
 * Options passed through to the underlying AgentExecutor.execute() call
 * once the deferred tool result (or rejection) has been appended to the
 * conversation.
 *
 * `sessionId`/`checkpointStore` are omitted here (in addition to the other
 * fields already omitted below) for the same reason `agent`/`input` are:
 * resumeAfterApproval() derives them itself rather than taking them from the
 * caller's `executeOptions`. `sessionId` comes from `snapshot.sessionId`
 * (the ExecutionSnapshot the paused run was paused with) and `checkpointStore`
 * comes from this function's own dedicated `checkpointStore` parameter - see
 * resumeAfterApproval() below for exactly what gets threaded through and why
 * that's safe.
 *
 * LOU-K5 update: earlier, this file forced BOTH to `undefined` on the
 * follow-up execute() call, as a "belt-and-suspenders" guard against
 * re-rehydrating stale pre-pause state. That guard was overbroad: it also
 * disabled checkpointing for the entire remainder of the resumed run, so a
 * crash a few tool-calls after a human approval would lose all progress
 * since the approval. resumeAfterApproval() now threads the real
 * `sessionId`/`checkpointStore` through instead, once it has already
 * deleted the stale pre-pause checkpoint - see the "Defense in depth"
 * comment below for why that ordering still makes rehydration impossible.
 *
 * LOU-T1: `businessState` is deliberately NOT in the Omit list below - a
 * caller may pass it here to explicitly override the value carried forward
 * from the pre-pause checkpoint. See resumeAfterApproval()'s `businessState:`
 * argument to the follow-up `AgentExecutor.execute()` call for the full
 * carry-forward-unless-overridden contract.
 */
export type ResumeExecuteOptions = Omit<
  ExecuteOptions,
  | 'agent'
  | 'input'
  | 'provider'
  | 'toolRegistry'
  | 'skipSystemPromptInjection'
  | 'initialSteps'
  | 'initialUsage'
  | 'sessionId'
  | 'checkpointStore'
> & {
  /**
   * LOU-W9.2: the agent as it is now, so `onAgentDrift` can compare its
   * instructions and model with the paused run's. Default: the paused agent
   * (`snapshot.agent`), which only drifts in its tools and the provider's
   * default model. `createAgent()` passes its own.
   */
  currentAgent?: AgentConfig;
  /**
   * N10b: who decides (route auth's principal, a channel's clicking user).
   * The approved tool sees it as `ctx.approval.by`. It never becomes the
   * run's principal: the resumed run acts for the principal it paused with
   * (`snapshot.principal`), and `principal` here is ignored.
   */
  approver?: Principal;
};

/**
 * Resume a paused AgentExecutor run after a human approves or rejects the
 * tool call it was waiting on.
 *
 * Deviation from the ticket snippet: AgentExecutor exposes only a static
 * `execute()` method (there is no instantiable AgentExecutor to inject),
 * so this takes the LLMProvider needed to keep generating instead of an
 * `executor: AgentExecutor` instance.
 *
 * @param checkpointStore Optional durable-execution CheckpointStore. When
 * the paused run's ExecutionSnapshot carries a `sessionId`, this is used
 * two ways: first, to proactively delete the stale checkpoint left behind
 * under that sessionId from before the pause (this closes the gap for a
 * LATER, unrelated execute() call against the same sessionId+checkpointStore
 * that doesn't go through resume at all, so it can't silently rehydrate
 * that stale pre-pause state either); second - LOU-K5 - it is then threaded
 * through, together with `snapshot.sessionId`, to the follow-up
 * AgentExecutor.execute() call that continues the run, so checkpointing
 * resumes for the remainder of the run instead of staying silently
 * disabled. This is safe because the delete happens first: by the time
 * execute() runs its rehydration check (`checkpointStore.load(sessionId)`),
 * there is nothing under that key, so it falls into the normal
 * "build from scratch" path using the reconstructed `messages`/
 * `initialSteps` below, exactly as if no checkpointStore had been passed at
 * all - it never rehydrates. If `checkpointStore` is omitted entirely,
 * both the delete and the pass-through are skipped and resume behaves
 * exactly as it did before durable execution existed.
 *
 * LOU-V1: `executeOptions.signal` cancels the resumed run exactly like
 * `ExecuteOptions.signal` - the approved tool receives it as `abortSignal`,
 * and the continued run resolves with `finishReason: 'aborted'` once it is
 * aborted, e.g. `resumeAfterApproval(decision, approvals, tools, provider,
 * { signal: controller.signal })`.
 */
export function resumeAfterApproval(
  decision: ApprovalDecision,
  approvalStore: ApprovalStore,
  toolRegistry: ToolRegistry,
  provider: LLMProvider,
  executeOptions: ResumeExecuteOptions = {},
  checkpointStore?: CheckpointStore
): Promise<ExecutionResult> {
  // LOU-D41: the decided call and the continuation report to the run's listeners.
  return observeRun(executeOptions, (observed) => resumeObserved(decision, approvalStore, toolRegistry, provider, observed, checkpointStore));
}

async function resumeObserved(
  decision: ApprovalDecision,
  approvalStore: ApprovalStore,
  toolRegistry: ToolRegistry,
  provider: LLMProvider,
  observed: ResumeExecuteOptions,
  checkpointStore?: CheckpointStore
): Promise<ExecutionResult> {
  const record = await approvalStore.resolve(decision.id);
  if (!record) {
    throw new SDKError(`No pending approval found for id '${decision.id}' (unknown or already resolved)`, 'LOUSHO_APPROVAL_NOT_FOUND');
  }

  const { pending, snapshot } = record;
  // N10b: the run goes on as the caller that paused it, whoever resumes it (an old snapshot: no principal).
  const { approver, ...rest } = observed;
  const executeOptions: ResumeExecuteOptions = { ...rest, principal: readonlyPrincipal(snapshot.principal) };
  // N9b: a sign-in pause continues only once the user signed in (else it stays paused), or ends as cancelled.
  const decided = await signInDecision(record, decision, approvalStore, executeOptions.tokens);
  const messages: Message[] = [...snapshot.currentMessages];
  const drift = await checkApprovalDrift(record, decided, { approvalStore, toolRegistry, provider, executeOptions });

  const staleCheckpoint = await clearStaleCheckpoint(snapshot.sessionId, checkpointStore);
  const staleBusinessState = staleCheckpoint?.businessState;

  const ctx: ResumeContext = {
    decision: decided,
    approvalStore,
    snapshot,
    messages,
    toolRegistry,
    executeOptions,
    usage: snapshot.usage ? restoreRunUsage(snapshot.usage) : emptyRunUsage(),
    execute: (options) => AgentExecutor.execute(options),
    resumeRun: resumeAfterApproval,
    approver: readonlyPrincipal(approver),
  };
  let step: Awaited<ReturnType<typeof decidedToolMessage>>;
  try {
    step = await streamedDecision(ctx, pending, drift);
  } catch (error) {
    // M10c: a paused sub-agent refused the resume before anything ran, so this run stays paused too.
    if (refusedResumes.has(error as object)) await restorePause({ pending, snapshot }, approvalStore, staleCheckpoint, checkpointStore);
    throw error;
  }
  if ('paused' in step) {
    // LOU-U8: the sub-agent paused again, so the session still awaits an approval.
    const businessState = executeOptions.businessState !== undefined ? executeOptions.businessState : staleBusinessState;
    await markAwaitingApproval(snapshot, step.paused, checkpointStore, businessState);
    return step.paused;
  }
  // LOU-Y1: a call whose sub-agent paused already has a placeholder result.
  replaceToolResult(messages, step.message);
  closeUnlistedToolCalls(messages, snapshot.remainingToolCalls);

  // LOU-U7: the turn's remaining calls still have no result here;
  // AgentExecutor.execute() finds them in the transcript and runs them
  // through its normal batch path before calling the model again.
  return continueResumedRun(snapshot, messages, {
    provider,
    toolRegistry,
    executeOptions,
    checkpointStore,
    approvalStore,
    staleBusinessState,
    usage: ctx.usage,
  });
}

/**
 * LOU-V14: {@link resumeAfterApproval} (same arguments, same result) streamed
 * as the `AgentRun` that `AgentExecutor.stream()` returns: `run.start`, the
 * decided call's `tool.start` / `tool.done` (`tool.error` for a rejection),
 * then the continuation's events as in a fresh run. A further pause ends it
 * with `approval.requested` and `run.done`. Aborting (`signal` or an early
 * `break`), `enqueue()` and `steer()` work as on a fresh run.
 *
 * @example
 * ```ts
 * const run = streamResumeAfterApproval({ id: approvalId, approved: true }, approvalStore, toolRegistry, provider);
 * for await (const event of run) if (event.type === 'text.delta') process.stdout.write(event.text);
 * ```
 */
export function streamResumeAfterApproval(
  decision: ApprovalDecision,
  approvalStore: ApprovalStore,
  toolRegistry: ToolRegistry,
  provider: LLMProvider,
  executeOptions: ResumeExecuteOptions = {},
  checkpointStore?: CheckpointStore
): AgentRun {
  return streamResumed(
    (wire) => resumeAfterApproval(decision, approvalStore, toolRegistry, provider, wire(executeOptions), checkpointStore),
    executeOptions.signal,
    executeOptions.inputQueue
  );
}

/** What resumeAfterApproval() takes, as one object (LOU-V14). */
export interface ResumeRequest {
  decision: ApprovalDecision;
  approvalStore: ApprovalStore;
  toolRegistry: ToolRegistry;
  provider: LLMProvider;
  executeOptions?: ResumeExecuteOptions;
  checkpointStore?: CheckpointStore;
}

/** resumeAfterApproval() with its arguments as one {@link ResumeRequest}. */
export function resumeRequest(request: ResumeRequest): Promise<ExecutionResult> {
  const { decision, approvalStore, toolRegistry, provider, executeOptions, checkpointStore } = request;
  return resumeAfterApproval(decision, approvalStore, toolRegistry, provider, executeOptions, checkpointStore);
}

/** M10c: drift errors of a resume check, which ran before anything of the paused run did. */
const refusedResumes = new WeakSet<object>();

/**
 * M10c: puts a paused run back as it was (its approval record, and the
 * session's 'awaiting-approval' checkpoint) after a paused sub-agent refused
 * the resume, so fixing the sub-agent and deciding again works.
 */
async function restorePause(
  { pending, snapshot }: ResolvedApproval,
  approvalStore: ApprovalStore,
  checkpoint: Checkpoint | null | undefined,
  checkpointStore: CheckpointStore | undefined
): Promise<void> {
  await approvalStore.save(pending, snapshot);
  if (checkpoint && snapshot.sessionId && checkpointStore) await checkpointStore.save(snapshot.sessionId, checkpoint);
}

/**
 * N9b: the decision on a `kind: 'sign-in'` pause as it is carried out.
 * Approving continues only when the run's user has a token for the provider
 * now; otherwise the record is put back and `LOUSHO_SIGNIN_PENDING` is thrown,
 * so the run stays paused. After the provider reported that the user declined,
 * approving cancels the call like `approved: false`.
 */
async function signInDecision(
  { pending, snapshot }: ResolvedApproval,
  decision: ApprovalDecision,
  approvalStore: ApprovalStore,
  tokens: OAuthTokenStore | undefined
): Promise<ApprovalDecision> {
  const signIn = pending.kind === 'sign-in' ? pending.signIn : undefined;
  if (!signIn || !decision.approved) return decision;
  if (signIn.declined) return { ...decision, approved: false };
  const owner = signInOwner(snapshot.principal ?? pending.principal);
  try {
    if (owner && tokens && (await tokens.get(signIn.provider, owner))) return decision;
  } catch (error) {
    await approvalStore.save(pending, snapshot);
    throw error;
  }
  await approvalStore.save(pending, snapshot);
  throw new SignInPendingError(signIn.displayName ?? signIn.provider);
}

/** N9b: the rejection a declined or cancelled call gets: a sign-in, a question, or a tool call. */
function rejectionOf(pending: PendingApproval): { error: string; kind: 'denied' | 'rejected' } {
  const described = describeApproval(pending);
  if (described.kind === 'sign-in') return { error: `Sign-in to ${described.signIn?.displayName ?? described.signIn?.provider ?? 'the provider'} was cancelled.`, kind: 'denied' };
  // LOU-X9: declining an `ask_question` call is not a tool rejection.
  if (described.kind === 'question') return { error: 'The user declined to answer the question', kind: 'rejected' };
  return { error: 'Tool execution was rejected by the reviewer', kind: 'rejected' };
}

/**
 * N9b: the approved call needed sign-in (again, or to another provider): the
 * run pauses again on it with a new `kind: 'sign-in'` approval - or, for the
 * app's own credential, the call gets the error.
 */
async function signInAgain(ctx: ResumeContext, pending: PendingApproval, signal: SignInRequired): Promise<{ message: Message } | { paused: ExecutionResult }> {
  const { snapshot, executeOptions } = ctx;
  const settled = await settleSignInRequired(signal, executeOptions.tokens);
  if ('error' in settled) {
    return { message: toolResultMessage(pending, toolErrorResult({ toolName: pending.toolName, error: settled.error }), true) };
  }
  const id = newId();
  const signIn = await signInRequest(settled.pause, executeOptions.tokens, { approvalId: id, sessionId: snapshot.sessionId });
  const next: PendingApproval = { ...pending, id, createdAt: new Date().toISOString(), kind: 'sign-in', signIn };
  delete next.question;
  await ctx.approvalStore.save(next, { ...snapshot, pendingToolCall: next, usage: structuredClone(ctx.usage) });
  runEventsOf(executeOptions as ExecuteOptions)?.approvalRequested(next);
  return { paused: { text: '', messages: ctx.messages, toolCalls: [], usage: ctx.usage, finishReason: 'awaiting-approval', steps: snapshot.steps, approvalId: id } };
}

/**
 * LOU-W9.2: compares the agent resuming a paused run with the one that paused
 * it (`onAgentDrift`) before anything runs: an approved call, or a call still
 * to run, whose tool is gone is always an error. On an error the approval
 * record, already taken from the store, is put back so the run stays paused.
 * M10c: a sub-agent's check (its own resume, nested in the lead's) throws an
 * error that propagates out of the sub-agent tool, so each enclosing run puts
 * its own record back too.
 */
async function checkApprovalDrift(
  { pending, snapshot }: ResolvedApproval,
  decision: ApprovalDecision,
  run: { approvalStore: ApprovalStore; toolRegistry: ToolRegistry; provider: LLMProvider; executeOptions: ResumeExecuteOptions }
): Promise<AgentDrift | undefined> {
  const { agentFingerprint: saved } = snapshot;
  if (!saved) return undefined;
  const { toolRegistry, executeOptions } = run;
  const configured = snapshot.agent.tools ?? {};
  const decided = decision.approved && !snapshot.subagent ? [pending.toolName] : [];
  const calls = [...decided, ...(snapshot.remainingToolCalls ?? []).map((call) => call.function.name)];
  const missingTools = [...new Set(calls)].filter((name) => name in configured && !toolRegistry.get(name)?.tool);
  try {
    const current = await fingerprintOf(executeOptions.currentAgent ?? snapshot.agent, toolRegistry, run.provider, executeOptions.hostedTools);
    return checkAgentDrift({ saved, current, mode: executeOptions.onAgentDrift, missingTools });
  } catch (error) {
    await run.approvalStore.save(pending, snapshot);
    if (typeof error === 'object' && error !== null) refusedResumes.add(error);
    markPropagating(error);
    throw error;
  }
}

/**
 * decidedToolMessage(), reported on a streamed resume (LOU-V14) as the run's
 * `start` and the decided call's `tool-call` / `tool-result` events.
 */
async function streamedDecision(ctx: ResumeContext, pending: PendingApproval, drift?: AgentDrift): ReturnType<typeof decidedToolMessage> {
  const sink = runEventsOf(ctx.executeOptions as ExecuteOptions);
  if (!sink) return decidedToolMessage(ctx, pending);
  const { agent, subagent } = ctx.snapshot;
  const call = subagent ?? pending;
  sink.runStart(agent);
  if (drift) sink.agentDrift(drift);
  const toolCall: ToolCall = {
    id: call.toolCallId,
    type: 'function',
    function: { name: call.toolName, arguments: JSON.stringify(call.args) },
  };
  sink.toolStart(toolCall);
  const step = await decidedToolMessage(ctx, pending);
  if ('message' in step) sink.toolSettled(toolResultOf(step.message));
  return step;
}

/** The outcome of a decided call's `tool` message, as `tool.done` / `tool.error` report it. */
function toolResultOf(message: Message): ToolSettled {
  const result: unknown = typeof message.content === 'string' ? JSON.parse(message.content) : message.content;
  const error = message.isError ? String((result as { message?: unknown } | null)?.message ?? '') : undefined;
  const replacedByHook = message.metadata?.replacedByHook;
  return {
    toolCallId: message.toolCallId ?? '',
    toolName: message.toolName ?? '',
    result,
    ...(error !== undefined && { error }),
    ...(typeof replacedByHook === 'string' && { replacedByHook }),
  };
}

/**
 * The `tool` message for the decided call: the approved tool's result, the
 * rejection - or, when the run paused on a sub-agent, the sub-agent's final
 * answer after resuming it with the decision (LOU-Y1).
 */
async function decidedToolMessage(
  ctx: ResumeContext,
  pending: PendingApproval
): Promise<{ message: Message } | { paused: ExecutionResult }> {
  const { snapshot, messages, executeOptions } = ctx;
  const runApproved = (
    call: PendingApproval,
    registry: ToolRegistry,
    scope: ToolCallScope,
    approval?: ToolExecutionContext['approval']
  ): Promise<Message> => runApprovedToolCall(call, snapshot, messages, registry, executeOptions, scope, approval);
  if (snapshot.subagent) {
    return resumeSubagentCall(ctx, snapshot.subagent, runApproved);
  }
  if (!ctx.decision.approved) {
    const { error, kind } = rejectionOf(pending);
    return { message: toolResultMessage(pending, toolErrorResult({ toolName: pending.toolName, error, kind, details: { note: ctx.decision.note } }), true) };
  }
  // N4: a call approved before a switch to plan mode does not run in plan mode.
  const { toolName, toolCallId, args } = pending;
  const { principal } = executeOptions;
  const planned = planModeRefusal(executeOptions, ctx.toolRegistry.get(toolName), { toolName, toolCallId, sessionId: ctx.snapshot.sessionId, ...(principal && { principal }), args });
  if (planned) {
    const error = `Tool '${toolName}' was denied by plan mode: ${planned}`;
    return { message: toolResultMessage(pending, toolErrorResult({ toolName, error, kind: 'denied', details: { reason: planned } }), true) };
  }
  // A sub-agent the approved tool starts inherits this resumed run's runtime.
  const scope: ToolCallScope = {
    runtime: { ...executeOptions, approvalStore: ctx.approvalStore },
    toolCallId: pending.toolCallId,
    onDelegatedUsage: (child) => mergeDelegatedUsage(ctx.usage, child),
    execute: ctx.execute,
  };
  // LOU-X9: the tool sees the decision's note (an `ask_question` answer) as `ctx.approval`; N10b: and who decided as `by`.
  let message: Message;
  try {
    message = await runApproved(pending, ctx.toolRegistry, scope, { note: ctx.decision.note, ...(ctx.approver && { by: ctx.approver }) });
  } catch (error) {
    if (!isSignInRequired(error)) throw error;
    return signInAgain(ctx, pending, error);
  }
  // LOU-X8: the transcript remembers the approval, for `once()`.
  return { message: { ...message, metadata: { ...message.metadata, ...approvalMarker(pending.args) } } };
}

/**
 * Defense in depth: a checkpoint under this sessionId (if any) was
 * written before this pause and is therefore stale by construction -
 * clear it now so it can't be loaded by this resume or by some later,
 * unrelated execute() call against the same sessionId+checkpointStore.
 *
 * Doing this BEFORE the AgentExecutor.execute() call in
 * continueResumedRun() (rather than just relying on
 * `skipSystemPromptInjection`/`initialSteps` to make a rehydration
 * "harmless") is what makes it safe to pass sessionId and checkpointStore
 * through to that call: its rehydration branch only triggers when
 * `checkpointStore.load(sessionId)` finds something, and by the time it
 * runs (synchronously after this delete resolves, with no intervening
 * await back to caller code) there is nothing left to find.
 *
 * Accepted race: if some OTHER process/caller writes a new checkpoint
 * under this exact sessionId in the narrow window between this delete
 * and the execute() call's load(), that checkpoint would be picked up
 * instead of the freshly-reconstructed messages. This mirrors how
 * ApprovalStore.resolve() is documented as delete-on-read without
 * an additional distributed lock (see executeApprovedTool()'s catch block) -
 * this codebase accepts same-sessionId-concurrent-caller races as an
 * existing caller-responsibility invariant (a sessionId identifies a single
 * logical run) rather than adding cross-process locking to CheckpointStore.
 *
 * LOU-T1: reads the pre-pause checkpoint off before deleting it (and
 * returns it), so its businessState can be carried forward into the
 * resumed run's own checkpoint-writes (see `businessState:` in
 * continueResumedRun()), and - M10c - so it can be put back when a paused
 * sub-agent refuses the resume. This load is purely a data read - it does
 * not touch, and has no bearing on, the rehydration-safety delete
 * immediately after it.
 */
async function clearStaleCheckpoint(
  sessionId: string | undefined,
  checkpointStore: CheckpointStore | undefined
): Promise<Checkpoint | null | undefined> {
  if (!sessionId || !checkpointStore) {
    return undefined;
  }
  const staleCheckpoint: Checkpoint | null = await checkpointStore.load(sessionId);
  await checkpointStore.delete(sessionId);
  return staleCheckpoint;
}

/**
 * LOU-U8 + LOU-Y1: when a resumed sub-agent pauses again, no execute() call
 * of this run writes a checkpoint (the stale one was just deleted), so mark
 * the session 'awaiting-approval' here - a later execute() on it then throws
 * SessionAwaitingApprovalError instead of starting over. Only the status,
 * approval id and businessState are read back: the next resumeAfterApproval()
 * rebuilds the run from its approval snapshot.
 */
async function markAwaitingApproval(
  snapshot: ExecutionSnapshot,
  paused: ExecutionResult,
  checkpointStore: CheckpointStore | undefined,
  businessState: unknown
): Promise<void> {
  if (!snapshot.sessionId || !checkpointStore) {
    return;
  }
  await checkpointStore.save(snapshot.sessionId, {
    agentId: snapshot.agent.id || '',
    sessionId: snapshot.sessionId,
    stepIndex: paused.steps,
    messages: paused.messages,
    toolCalls: [],
    usage: structuredClone(paused.usage),
    finishReason: paused.finishReason,
    businessState,
    status: 'awaiting-approval',
    approvalId: paused.approvalId,
    agentFingerprint: snapshot.agentFingerprint,
    runConfig: snapshot.agent.metadata?.[RUN_CONFIG_KEY],
    ...(snapshot.principal && { principal: snapshot.principal }),
  });
}

/**
 * LOU-U7 backward compatibility: a snapshot saved before
 * `remainingToolCalls` existed records no remaining calls, so - as before -
 * no other call of the paused turn runs on resume. Each one still without a
 * result gets an error result instead, so the transcript stays valid for
 * the provider (every tool call answered exactly once).
 */
function closeUnlistedToolCalls(messages: Message[], remaining: ToolCall[] | undefined): void {
  const keep = new Set((remaining ?? []).map((call) => call.id));
  for (const call of splitPendingTurn(messages).pendingToolCalls) {
    if (keep.has(call.id)) {
      continue;
    }
    messages.push({
      role: 'tool',
      content: JSON.stringify(
        toolErrorResult({
          toolName: call.function.name,
          error: 'Tool call was not run: the run paused for approval before reaching it and this approval was saved without its remaining calls',
          kind: 'not-run',
        })
      ),
      name: call.function.name,
      toolCallId: call.id,
      toolName: call.function.name,
      isError: true,
    });
  }
}

/** The `tool` message carrying a resumed tool call's result (or rejection). */
function toolResultMessage(pending: PendingApproval, payload: unknown, isError = false, replacedByHook?: string): Message {
  return {
    role: 'tool',
    content: JSON.stringify(payload),
    name: pending.toolName,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
    ...(isError && { isError }),
    ...(replacedByHook !== undefined && { metadata: { replacedByHook } }),
  };
}

/**
 * Runs the tool call a human just approved - with the same pre/post
 * tool-call hooks and sandbox routing as AgentExecutor's own tool calls -
 * and returns the `tool` message carrying its result.
 */
async function runApprovedToolCall(
  pending: PendingApproval,
  snapshot: ExecutionSnapshot,
  messages: Message[],
  toolRegistry: ToolRegistry,
  executeOptions: ResumeExecuteOptions,
  scope?: ToolCallScope,
  approval?: ToolExecutionContext['approval']
): Promise<Message> {
  const toolDesc = toolRegistry.get(pending.toolName);
  // A `requiresSandbox` tool may have no `tool.execute` implementation at
  // all - its real work happens in `sandboxExecute()` instead - so the
  // "not found" guard below must not reject that case outright; it only
  // means there is genuinely no way to run the tool (neither a direct
  // `execute` nor a `sandboxExecute`).
  if (!toolDesc || !toolDesc.tool || (!getToolExecute(toolDesc) && !toolDesc.sandboxExecute)) {
    return toolResultMessage(
      pending,
      toolErrorResult({
        toolName: pending.toolName,
        error: `Tool '${pending.toolName}' not found in registry`,
        kind: 'not-found',
      }),
      true
    );
  }

  // LOU-Q1: hooks must fire for this deferred, post-approval execution
  // path too - not just AgentExecutor's own main-loop tool call site -
  // since this is a genuine, independent point where a tool actually
  // runs. `args` is a mutable object a `preToolCall` hook (e.g.
  // redact-pii) can rewrite in place before the real execution below, the
  // same contract AgentExecutor.executeToolCall() offers.
  const hooks: HookRegistry | undefined = executeOptions.hooks;
  // A copy hooks may change freely: LOU-X3.2 compares it with `pending.args`.
  const hookArgs: Record<string, unknown> = structuredClone(pending.args);
  const hookCtx = {
    agentId: snapshot.agent.id,
    agentName: snapshot.agent.name,
    sessionId: snapshot.sessionId,
    ...(executeOptions.principal && { principal: executeOptions.principal }),
    messages,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
    args: hookArgs,
    toolCall: {
      id: pending.toolCallId,
      type: 'function' as const,
      function: { name: pending.toolName, arguments: JSON.stringify(pending.args) },
    },
  };

  // LOU-X3: a pre-hook may deny the call or supply its result; input it
  // supplies must match what the human approved.
  const verdict = hooks
    ? await runPreToolHooks(hooks, hookCtx, { toolRegistry, runtime: executeOptions, approvedArgs: pending.args })
    : { args: hookArgs };
  const settled: SettledCall = verdict.outcome
    ? settledByHook(verdict.outcome)
    : await executeApprovedTool(pending, toolDesc, verdict.args, executeOptions, { messages, approval, sessionId: snapshot.sessionId }, scope);
  const { result, toolError, errorResult } = settled;

  // Fires (with the settled result/error) regardless of how the tool
  // settled - matching AgentHook.postToolCall's documented contract
  // ("Invoked immediately after a tool call settles (success, tool-level
  // error, or approval-required)"). Deliberately OUTSIDE
  // executeApprovedTool()'s try/catch: a throw here is a hook error, not a
  // tool error, and must propagate out of resumeAfterApproval() unconverted
  // (see executeApprovedTool()).
  const payload = { result, error: toolError };
  const replacedBy = hooks ? await hooks.runPostToolCall(hookCtx, payload) : undefined;
  const shown = replacedBy !== undefined ? payload.result : (errorResult ?? result);
  return toolResultMessage(pending, shown, errorResult !== undefined, replacedBy ?? settled.replacedByHook);
}

/** A call a pre-tool hook settled (LOU-X3), in executeApprovedTool()'s shape. */
function settledByHook(outcome: ToolCallOutcome): SettledCall {
  if (outcome.error !== undefined) {
    return { result: undefined, toolError: outcome.error, errorResult: outcome.result as ToolErrorResult };
  }
  return { result: outcome.result, replacedByHook: outcome.replacedByHook };
}

/** How an approved call settled: its result, or its error (plain message and structured result). */
interface SettledCall {
  result: unknown;
  toolError?: string;
  errorResult?: ToolErrorResult;
  /** LOU-X3: the pre-tool hook that supplied `result`. */
  replacedByHook?: string;
}

/**
 * Executes the approved tool itself. The try/catch here handles ONLY the
 * tool's own execution failure - NOT the postToolCall hook call that
 * follows it in runApprovedToolCall(). This split (rather than the previous
 * single try wrapping both the tool call and the hook call) matters:
 * hooks.ts's HookRegistry doc comment - and runApprovedToolCall()'s own
 * preToolCall comment - both document that a hook's thrown error must
 * propagate out of resumeAfterApproval() as a rejected promise, never
 * be silently swallowed. With the hook call inside the same try as the
 * tool execution, a postToolCall hook's error (e.g. a rate-limit hook
 * meaning to HALT the run) was being caught by the generic
 * "every other thrown tool error is turned into a graceful tool-result"
 * branch below and converted into a benign {error} message instead of
 * aborting - exactly the silent-swallow behavior that invariant forbids.
 */
async function executeApprovedTool(
  pending: PendingApproval,
  toolDesc: ToolDescriptor,
  args: Record<string, unknown>,
  executeOptions: ResumeExecuteOptions,
  { messages, approval, sessionId }: { messages: Message[]; approval?: ToolExecutionContext['approval']; sessionId?: string },
  scope?: ToolCallScope
): Promise<SettledCall> {
  try {
    // Mirrors AgentExecutor.executeToolCall()'s fail-closed handling of
    // `requiresSandbox` tools (LOU-F5) via the shared
    // executeToolWithSandboxGuard() helper (LOU-F fix), so a deferred
    // tool executed after human approval can't silently bypass the
    // sandbox seam the way it previously did.
    const sandbox = executeOptions.sandbox ?? NoopSandbox;
    return {
      result: await executeToolWithSandboxGuard(
        pending.toolName,
        toolDesc,
        args,
        sandbox,
        executeOptions.signal,
        { toolCallId: pending.toolCallId, messages, approval, sessionId, principal: executeOptions.principal, tokens: executeOptions.tokens, onPartial: partialsOf(pending, executeOptions) },
        scope
      ),
    };
  } catch (error) {
    // N9b: the call needs sign-in: decidedToolMessage() pauses the run again.
    if (isSignInRequired(error)) throw error;
    // Mirror AgentExecutor.executeToolCall's (post-fix) handling of a
    // thrown tool error: errors that mark themselves as
    // `PropagatingToolError` (e.g. DelegationDepthExceededError) must NOT
    // be converted into a conversational {error} tool-result - that would
    // hand the LLM exactly the kind of "your tool call failed, try again"
    // signal that triggers another delegation attempt, defeating the
    // whole point of the depth guard. toolErrorMessage() rethrows those so
    // they propagate out of this function as a rejected promise instead,
    // exactly like AgentExecutor.executeToolCall does.
    //
    // Every other thrown tool error is turned into a graceful tool-result
    // message instead of letting it reject this promise. By this point
    // the pending-approval record has already been deleted
    // (ApprovalGate.resolve() is delete-on-read), so failing to catch
    // here would mean the whole resume just fails with no retry path.
    // LOU-U14: the model gets the same structured error as in the main loop;
    // `toolError` keeps the plain message for the postToolCall hook.
    return {
      result: undefined,
      toolError: toolErrorMessage(error),
      errorResult: toolErrorResult({ toolName: pending.toolName, error }),
    };
  }
}

/** N13b: a streamed resume reports the decided call's snapshots as `tool.partial` (its `tool.start` was reported by streamedDecision()). */
function partialsOf(pending: PendingApproval, executeOptions: ResumeExecuteOptions): ((output: unknown) => void) | undefined {
  const report = partialSink(executeOptions);
  return report && ((output) => report(pending.toolCallId, pending.toolName, output));
}

/**
 * Continues the paused run via AgentExecutor.execute(), with the deferred
 * tool result (or rejection) now appended to `messages`.
 *
 * LOU-K5: sessionId/checkpointStore are threaded through so AgentExecutor
 * resumes writing per-tool-result checkpoints for the rest of this run
 * (previously both were forced to `undefined` here, which also killed
 * forward checkpointing for the whole remainder of the resumed run -
 * not just the resume step itself). `snapshot.sessionId` and
 * resumeAfterApproval()'s own `checkpointStore` parameter are used
 * explicitly here rather than whatever (if anything) `executeOptions`
 * carries, since `ResumeExecuteOptions` omits both fields - see that type's
 * doc comment. This still can't rehydrate stale state: the stale
 * pre-pause checkpoint under `snapshot.sessionId` was already deleted by
 * clearStaleCheckpoint(), so AgentExecutor.execute()'s
 * `checkpointStore.load(sessionId)` rehydration check finds nothing and
 * falls into its normal "build from scratch" path, using exactly the
 * `input`/`skipSystemPromptInjection`/`initialSteps` reconstructed below -
 * it never re-triggers the rehydration branch this guard used to worry
 * about. When no `checkpointStore` was passed to resumeAfterApproval() at
 * all, this is `undefined` and AgentExecutor.execute() behaves exactly as
 * it always has for callers that don't use durable execution.
 */
function continueResumedRun(
  snapshot: ExecutionSnapshot,
  messages: Message[],
  run: {
    provider: LLMProvider;
    toolRegistry: ToolRegistry;
    executeOptions: ResumeExecuteOptions;
    checkpointStore?: CheckpointStore;
    approvalStore: ApprovalStore;
    staleBusinessState: unknown;
    usage: RunUsage;
  }
): Promise<ExecutionResult> {
  const { executeOptions } = run;
  return AgentExecutor.execute({
    ...executeOptions,
    agent: snapshot.agent,
    input: messages,
    provider: run.provider,
    toolRegistry: run.toolRegistry,
    sessionId: snapshot.sessionId,
    checkpointStore: run.checkpointStore,
    // LOU-U7: a remaining call of the paused turn (or a later one) may need
    // approval too - it pauses into the same store unless told otherwise.
    approvalStore: executeOptions.approvalStore ?? run.approvalStore,
    // LOU-T1: carry the pre-pause checkpoint's businessState forward into
    // the resumed run's own checkpoint-writes by default, so a consumer's
    // domain state (order id, ticket id, workflow stage, ...) survives a
    // pause-for-approval -> approve/reject -> resume cycle - the whole
    // point of co-locating it with execution state in the first place. An
    // explicit `executeOptions.businessState` always wins, so a caller can
    // still deliberately override or drop it. See clearStaleCheckpoint()
    // (which read it off the checkpoint BEFORE deleting it) for why this
    // has no bearing on the rehydration safety property documented above -
    // businessState is inert data, not execution state.
    businessState:
      executeOptions.businessState !== undefined
        ? executeOptions.businessState
        : run.staleBusinessState,
    // `messages` was reconstructed from the ExecutionSnapshot's
    // currentMessages, which already include the original system message
    // (if any) that AgentExecutor's fresh-run path built the first time
    // this agent ran. Because the stale checkpoint was already deleted,
    // execute() always falls into its "build from scratch" path here
    // (never the rehydration path) - without skipSystemPromptInjection,
    // that path would prepend a second, duplicate system message built
    // fresh from agent.prompt on top of the one already in `messages`.
    skipSystemPromptInjection: true,
    // Continue step-budget accounting from where the paused run left off,
    // rather than silently resetting to a full fresh maxSteps allowance.
    // snapshot.steps is the step count AgentExecutor.execute() had already
    // reached (see ExecutionSnapshot) at the moment it paused for approval.
    initialSteps: snapshot.steps,
    // LOU-V5: and usage totals, rather than restarting them at zero
    // (including a resumed sub-agent's usage, LOU-Y1).
    initialUsage: run.usage,
  });
}
