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
  ApprovalGroupMember,
  ApprovalStore,
  approvalExpired,
  describeApproval,
  ExecutionSnapshot,
  GroupDecision,
  isAutomaticDecision,
  markAutomaticDecision,
  PendingApproval,
  ResolvedApproval,
  withGroupDecisions,
} from './ApprovalGate';
import { validateToolArguments } from './toolArgsValidation';
import { AgentExecutor, ExecuteOptions, ExecutionResult, extendRunOptions } from './AgentExecutor';
import { observeRun, partialSink, runEventsOf, streamResumed, type AgentRun, type ToolSettled } from './agentRun';
import { Checkpoint, CheckpointStore, RUN_CONFIG_KEY } from './checkpoint';
import { checkAgentDrift, fingerprintOf, type AgentDrift } from './agentFingerprint';
import type { AgentConfig } from '../types';
import { NoopSandbox } from '../security/sandboxCore';
import { executeToolWithSandboxGuard } from './sandboxGuard';
import { HookRegistry, type ToolCallHookContext } from './hooks';
import { runPreToolHooks, type ToolCallOutcome } from './toolCallExecution';
import { activeAgentOf, handOff, handoffNamed, handoffToolRegistry, type HandoffMarker, type ResolvedHandoff } from './handoffRun';
import { markPropagating, toolErrorMessage } from './propagatingToolError';
import { ConfigurationError, SDKError } from './errors';
import { toolErrorResult, type ToolErrorResult } from './toolErrors';
import { toolResultContent } from './toolResult';
import { insertToolResult, splitPendingTurn } from './transcript';
import { replaceToolResult, type ToolCallScope } from './subagentRuntime';
import type { RunUsage } from '../models/usage';
import { emptyRunUsage, mergeDelegatedUsage, restoreRunUsage } from './runUsage';
import { planModeRefusal, reportApprovalExpiry } from './permissions';
import { RUN_CODE_TOOL, codeModeOf, nestedToolCaller, withCodeMode } from './codeMode';
import { withToolSearch } from './toolSearch';
import { pauseAgain, resumeSubagentCall, type ResumeContext } from './resumeSubagent';
import type { Principal } from '../auth/types';
import { readonlyPrincipal } from './runPrincipal';
import type { OAuthTokenStore } from '../oauth/types';
import { isSignInRequired, settleSignInRequired, signInOwner, signInRequest, SignInPendingError, type SignInRequired } from '../oauth/signIn';
import { newId } from '../utils/id';
import { agentRunSpanInit, recordToolOutcome, resolveCaptureContent, toolSpanInit, SUBAGENT_SPAN, type SubagentSpanInfo } from './genAiSpans';
import { withSpan, type Span } from './tracing';

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
  | 'agentSpanId'
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
  const claimed = await approvalStore.resolve(decision.id);
  if (!claimed) {
    throw new SDKError(`No pending approval found for id '${decision.id}' (unknown or already resolved)`, 'LOUSHO_APPROVAL_NOT_FOUND');
  }
  // Eve TOOLS-F12: a call of a step paused on several - the step runs once the last of them is decided.
  const grouped = (claimed.snapshot.approvalGroup?.length ?? 0) > 1;
  const claim = await recordToResume(claimed, decision, approvalStore, toolRegistry, observed, checkpointStore, grouped);
  if ('paused' in claim) return claim.paused;
  const { record } = claim;

  const { pending, snapshot } = record;
  // N10b: the run goes on as the caller that paused it, whoever resumes it (an old snapshot: no principal).
  const { approver, ...rest } = observed;
  const executeOptions = resumedOptions(rest, snapshot);
  const decided = await effectiveDecision(record, decision, approvalStore, executeOptions, grouped);
  const messages: Message[] = [...snapshot.currentMessages];
  const drift = await checkApprovalDrift(record, decided, { approvalStore, toolRegistry, provider, executeOptions }, grouped ? claimed : record);

  const staleCheckpoint = await clearStaleCheckpoint(snapshot.sessionId, checkpointStore);

  const ctx: ResumeContext = {
    decision: decided,
    approvalStore,
    snapshot,
    messages,
    toolRegistry,
    executeOptions,
    provider,
    usage: snapshot.usage ? restoreRunUsage(snapshot.usage) : emptyRunUsage(),
    execute: (options) => AgentExecutor.execute(options),
    resumeRun: resumeAfterApproval,
    approver: readonlyPrincipal(approver),
  };
  // #281: the decided tool runs inside the continued run's `invoke_agent` span, which the continuation then adopts.
  const captureContent = resolveCaptureContent(executeOptions.captureContent);
  const runSpan = (): ReturnType<typeof agentRunSpanInit> =>
    agentRunSpanInit(
      { agent: snapshot.agent, provider, sessionId: snapshot.sessionId, input: messages, [SUBAGENT_SPAN]: (executeOptions as { [SUBAGENT_SPAN]?: SubagentSpanInfo })[SUBAGENT_SPAN] },
      { redactContent: executeOptions.redactContent, captureContent }
    );
  const init = runSpan();
  const resumed: ResumedRun = { ctx, claimed, pending, drift, staleCheckpoint, checkpointStore, runSpan };
  return withSpan(executeOptions.exporter, init.name, init.attributes, (span) => continueInRunSpan(resumed, span), executeOptions.parentSpanId, init.kind);
}

/**
 * The record a resume runs from: the claimed one (with any edited arguments)
 * or, for a group, the record once the last call is decided; `paused` while
 * other calls of the group are undecided.
 */
async function recordToResume(
  claimed: ResolvedApproval,
  decision: ApprovalDecision,
  approvalStore: ApprovalStore,
  toolRegistry: ToolRegistry,
  observed: ResumeExecuteOptions,
  checkpointStore: CheckpointStore | undefined,
  grouped: boolean
): Promise<{ record: ResolvedApproval } | { paused: ExecutionResult }> {
  if (grouped) {
    const step = await decideGroupMember(claimed, decision, approvalStore, toolRegistry, observed);
    if ('paused' in step) await markGroupPending(claimed.snapshot, step.paused, checkpointStore);
    return step;
  }
  // Eve TOOLS-F19: "approve with edits" - invalid arguments leave the approval pending.
  try {
    return { record: await withEditedArgs(claimed, decision, toolRegistry, observed) };
  } catch (error) {
    return putBackRefused(claimed, approvalStore, error);
  }
}

/** Puts a claimed record back and rethrows `error`, marking it so a lead's resume puts its own pause back too. */
async function putBackRefused(claimed: ResolvedApproval, approvalStore: ApprovalStore, error: unknown): Promise<never> {
  await approvalStore.save(claimed.pending, claimed.snapshot);
  // Inside a sub-agent's resume, the lead's run puts its own pause back too.
  if (typeof error === 'object' && error !== null) refusedResumes.add(error);
  throw error;
}

/** The resuming call's options (less its `approver`) with the paused run's principal and, unless overridden, metadata. */
function resumedOptions(rest: Omit<ResumeExecuteOptions, 'approver'>, snapshot: ExecutionSnapshot): ResumeExecuteOptions {
  return {
    ...rest,
    principal: readonlyPrincipal(snapshot.principal),
    // LOU-R16: and its hooks keep seeing the metadata it paused with, unless the resuming call passed its own.
    ...(rest.metadata === undefined && snapshot.metadata !== undefined && { metadata: snapshot.metadata }),
  };
}

/** The decision the resumed call runs with: TTL and sign-in applied to a single call's `decision`. */
async function effectiveDecision(
  record: ResolvedApproval,
  decision: ApprovalDecision,
  approvalStore: ApprovalStore,
  executeOptions: ResumeExecuteOptions,
  grouped: boolean
): Promise<ApprovalDecision> {
  // TTL: a pause decided after its `expiresAt` is denied, whatever the
  // decision says - a stale approve must never run the tool. The denial is
  // what rejectionOf() reports to the model, so a resumed run sees the
  // expiry, and a sign-in pause that lapsed is denied rather than re-armed.
  // Eve TOOLS-F12: a group's calls were each checked when they were decided (groupDecision()).
  const decided = grouped
    ? decision
    : approvalExpired(record.pending)
      ? { ...decision, approved: false }
      : // N9b: a sign-in pause continues only once the user signed in (else it stays paused), or ends as cancelled.
        await signInDecision(record, decision, approvalStore, executeOptions.tokens);
  // Eve TOOLS-F19: a copy of an `approve` callback's decision is still the callback's (once() does not remember it).
  if (decided !== decision && isAutomaticDecision(decision)) markAutomaticDecision(decided);
  return decided;
}

/** What {@link continueInRunSpan} needs of a resume whose decision is settled. */
interface ResumedRun {
  ctx: ResumeContext;
  claimed: ResolvedApproval;
  pending: PendingApproval;
  drift: AgentDrift | undefined;
  staleCheckpoint: Checkpoint | null | undefined;
  checkpointStore: CheckpointStore | undefined;
  runSpan: () => ReturnType<typeof agentRunSpanInit>;
}

type DecidedStep = Awaited<ReturnType<typeof decidedToolMessage>> | { group: true };

/** Runs the decided call (or group), then pauses again, hands off or continues the run, inside the run's span. */
async function continueInRunSpan(resumed: ResumedRun, span: Span): Promise<ExecutionResult> {
  const { ctx, checkpointStore, runSpan } = resumed;
  const { snapshot, messages, executeOptions, provider, toolRegistry, approvalStore } = ctx;
  ctx.runSpanId = span.id;
  const step = await runDecidedStep(resumed);
  const staleBusinessState = resumed.staleCheckpoint?.businessState;
  const businessState = executeOptions.businessState !== undefined ? executeOptions.businessState : staleBusinessState;
  if ('paused' in step) {
    // LOU-U8: the sub-agent paused again, so the session still awaits an approval.
    await markAwaitingApproval(snapshot, step.paused, checkpointStore, businessState);
    return step.paused;
  }
  // N6: the approved transfer completed its switch - continue the run as the target.
  if ('handoff' in step) return continueHandoff(ctx, step.handoff, span, checkpointStore, businessState);
  // LOU-Y1: a call whose sub-agent paused already has a placeholder result.
  if ('message' in step) replaceToolResult(messages, step.message);
  // Eve TOOLS-F12: a sub-agent of the step paused too - the run pauses on it now.
  const held = snapshot.subagent ? undefined : snapshot.heldSubagent;
  if (held) {
    const paused = await pauseAgain(ctx, held);
    await markAwaitingApproval(snapshot, paused, checkpointStore, businessState);
    return paused;
  }
  closeUnlistedToolCalls(messages, snapshot.remainingToolCalls);
  // The span's input is the transcript the continued run starts from, decided call included.
  span.attributes = { ...span.attributes, ...runSpan().attributes };

  // LOU-U7: the turn's remaining calls still have no result here;
  // AgentExecutor.execute() finds them in the transcript and runs them
  // through its normal batch path before calling the model again.
  return keepTurnOnFailure(snapshot, messages, checkpointStore, businessState, ctx.usage, () =>
    continueResumedRun(snapshot, messages, {
      provider,
      toolRegistry,
      executeOptions,
      checkpointStore,
      approvalStore,
      staleBusinessState,
      usage: ctx.usage,
      agentSpanId: span.id,
    })
  );
}

/** Runs the decided call (or a decided group's calls); a refused sub-agent resume restores this run's pause. */
async function runDecidedStep({ ctx, claimed, pending, drift, staleCheckpoint, checkpointStore }: ResumedRun): Promise<DecidedStep> {
  const { snapshot } = ctx;
  try {
    // Eve TOOLS-F12: a decided group runs all its calls (a sub-agent's group runs inside the sub-agent).
    return snapshot.approvalGroup && !snapshot.subagent ? await runDecidedGroup(ctx, snapshot.approvalGroup, drift) : await streamedDecision(ctx, pending, drift);
  } catch (error) {
    // M10c: a paused sub-agent refused the resume before anything ran, so this run stays paused too.
    if (refusedResumes.has(error as object)) await restorePause(claimed, ctx.approvalStore, staleCheckpoint, checkpointStore);
    throw error;
  }
}

/** N6: continues the run as the handoff's target, from the switched transcript. */
function continueHandoff(
  ctx: ResumeContext,
  handoff: HandoffSwitch,
  span: Span,
  checkpointStore: CheckpointStore | undefined,
  businessState: unknown
): Promise<ExecutionResult> {
  const { snapshot, executeOptions } = ctx;
  return keepTurnOnFailure(snapshot, handoff.messages, checkpointStore, businessState, ctx.usage, () =>
    AgentExecutor.execute({
      ...handoff.options,
      agentSpanId: span.id,
      input: handoff.messages,
      sessionId: snapshot.sessionId,
      ...(snapshot.contextSessionId !== undefined && { contextSessionId: snapshot.contextSessionId }),
      checkpointStore,
      approvalStore: executeOptions.approvalStore ?? ctx.approvalStore,
      businessState,
      // The switched transcript already starts with the target's system prompt.
      skipSystemPromptInjection: true,
      initialSteps: snapshot.steps,
      initialUsage: ctx.usage,
    })
  );
}

/**
 * LOU-V14: {@link resumeAfterApproval} (same arguments, same result) streamed
 * as the `AgentRun` that `AgentExecutor.stream()` returns: `run.start`, the
 * decided call's `tool.resume` / `tool.done` (`tool.error` for a rejection;
 * `tool.resume` because its `tool.start` was emitted by the run that paused,
 * LOU-R17), then the continuation's events as in a fresh run. A further pause ends it
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
 * Eve TOOLS-F19: `record` with the decision's edited `args` in place of the
 * model's - validated against the tool's schema, and written into the
 * transcript's tool call so the model sees what ran. `record` itself when the
 * decision edits nothing (or rejects). A sub-agent's call passes the edit on
 * to the sub-agent's own resume. Throws `LOUSHO_TOOL_ARGS_INVALID` for
 * arguments the schema refuses, `LOUSHO_CONFIG_INVALID` for a pause whose
 * arguments cannot be edited.
 */
async function withEditedArgs(
  record: ResolvedApproval,
  decision: ApprovalDecision,
  toolRegistry: ToolRegistry,
  executeOptions: ResumeExecuteOptions
): Promise<ResolvedApproval> {
  const { pending, snapshot } = record;
  if (!decision.approved || decision.args === undefined || snapshot.subagent) return record;
  const kind = describeApproval(pending).kind;
  if ((kind !== undefined && kind !== 'tool') || handoffNamed(executeOptions, pending.toolName)) {
    throw new ConfigurationError(`Approval '${decision.id}' is a ${kind ?? 'handoff'}, whose arguments cannot be edited: decide it without 'args'.`, 'args');
  }
  if (typeof decision.args !== 'object' || decision.args === null || Array.isArray(decision.args)) {
    throw new ConfigurationError(`Approval '${decision.id}': 'args' must be an object of the tool's arguments.`, 'args');
  }
  const toolDesc = toolRegistry.get(pending.toolName);
  const args = (toolDesc ? await validateToolArguments(pending.toolName, toolDesc, decision.args) : decision.args) as Record<string, unknown>;
  const edited: PendingApproval = { ...pending, args };
  const currentMessages = withCallArgs(snapshot.currentMessages, pending.toolCallId, args);
  return { pending: edited, snapshot: { ...snapshot, pendingToolCall: edited, currentMessages } };
}

/** Eve TOOLS-F19: `messages` with the arguments of tool call `toolCallId` replaced by `args` (new message objects, never in place). */
function withCallArgs(messages: Message[], toolCallId: string, args: Record<string, unknown>): Message[] {
  return messages.map((message) =>
    message.role === 'assistant' && message.toolCalls?.some((call) => call.id === toolCallId)
      ? {
          ...message,
          toolCalls: message.toolCalls.map((call) => (call.id === toolCallId ? { ...call, function: { ...call.function, arguments: JSON.stringify(args) } } : call)),
        }
      : message
  );
}

/**
 * Eve TOOLS-F12: in-process serialization of the decisions on one group (keyed
 * by its first call's approval id), so two decisions made at the same time
 * cannot both find the other's record claimed.
 */
const groupLocks = new Map<string, Promise<unknown>>();

function withGroupLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = groupLocks.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => undefined);
  groupLocks.set(key, settled);
  void settled.then(() => {
    if (groupLocks.get(key) === settled) groupLocks.delete(key);
  });
  return next;
}

/**
 * Eve TOOLS-F12: decides one call of a step paused on several. While other
 * calls of the step are undecided, the decision is written into their
 * records and the run stays paused (`paused`, listing what is left); the
 * decision that completes the group returns the `record` to run the whole
 * step from (every call's decision in its `approvalGroup`). Invalid edited
 * arguments, an early sign-in approval and a lost race put the claimed
 * record back and throw.
 */
async function decideGroupMember(
  claimed: ResolvedApproval,
  decision: ApprovalDecision,
  approvalStore: ApprovalStore,
  toolRegistry: ToolRegistry,
  observed: ResumeExecuteOptions
): Promise<{ record: ResolvedApproval } | { paused: ExecutionResult }> {
  const { pending, snapshot } = claimed;
  const group = snapshot.approvalGroup ?? [];
  return withGroupLock(group[0]?.pending.id ?? pending.id, async () => {
    try {
      // A sub-agent's record already holds the decisions its lead collected.
      const mine = group.find((member) => member.pending.id === pending.id)?.decision ?? (await groupDecision(claimed, decision, approvalStore, toolRegistry, observed));
      const decided = new Map<string, GroupDecision>();
      for (const member of group) if (member.decision) decided.set(member.pending.id, member.decision);
      decided.set(pending.id, mine);
      const waiting = await claimWaitingSiblings(group, decided, approvalStore, pending.id);
      if (waiting.length === 0) return { record: { pending, snapshot: withGroupDecisions(snapshot, decided) } };
      for (const sibling of waiting) await approvalStore.save(sibling.pending, withGroupDecisions(sibling.snapshot, decided));
      return { paused: groupPaused(snapshot, waiting) };
    } catch (error) {
      return putBackRefused(claimed, approvalStore, error);
    }
  });
}

/**
 * Eve TOOLS-F12: claims the group's calls still waiting, which take the
 * decisions in `decided` (and add to it any decision another resolver wrote
 * into them). A call being decided elsewhere puts the claimed ones back and throws.
 */
async function claimWaitingSiblings(
  group: ApprovalGroupMember[],
  decided: Map<string, GroupDecision>,
  approvalStore: ApprovalStore,
  pendingId: string
): Promise<ResolvedApproval[]> {
  const waiting: ResolvedApproval[] = [];
  for (const member of group) {
    if (decided.has(member.pending.id)) continue;
    const sibling = await approvalStore.resolve(member.pending.id);
    if (!sibling) {
      for (const taken of waiting) await approvalStore.save(taken.pending, taken.snapshot);
      throw new SDKError(
        `Approval '${member.pending.id}' of the same step as '${pendingId}' is being decided by another request; decide '${pendingId}' again once it is done.`,
        'LOUSHO_APPROVAL_CONFLICT'
      );
    }
    adoptDecisions(sibling.snapshot, decided);
    waiting.push(sibling);
  }
  return waiting;
}

/** Adds to `decided` the decisions another resolver wrote into `snapshot`'s group that it does not have yet. */
function adoptDecisions(snapshot: ExecutionSnapshot, decided: Map<string, GroupDecision>): void {
  for (const other of snapshot.approvalGroup ?? []) if (other.decision && !decided.has(other.pending.id)) decided.set(other.pending.id, other.decision);
}

/** Eve TOOLS-F12: the run's result while the `waiting` calls of its step are undecided. */
function groupPaused(snapshot: ExecutionSnapshot, waiting: ResolvedApproval[]): ExecutionResult {
  const ids = waiting.map((sibling) => sibling.pending.id);
  return {
    text: '',
    messages: [...snapshot.currentMessages],
    toolCalls: [],
    usage: snapshot.usage ? restoreRunUsage(snapshot.usage) : emptyRunUsage(),
    finishReason: 'awaiting-approval',
    steps: snapshot.steps,
    approvalId: ids[0],
    approvalIds: ids,
  };
}

/**
 * Eve TOOLS-F12: `decision` as a group keeps it: an expired call is denied
 * (TTL), a sign-in is approved only once the user signed in, and edited
 * arguments are validated (a sub-agent's call: by the sub-agent's resume).
 */
async function groupDecision(
  claimed: ResolvedApproval,
  decision: ApprovalDecision,
  approvalStore: ApprovalStore,
  toolRegistry: ToolRegistry,
  observed: ResumeExecuteOptions
): Promise<GroupDecision> {
  const { pending, snapshot } = claimed;
  const expired = approvalExpired(pending);
  let approved = decision.approved && !expired;
  if (approved && pending.kind === 'sign-in') approved = (await signInDecision(claimed, decision, approvalStore, observed.tokens)).approved;
  let args: Record<string, unknown> | undefined;
  if (approved && decision.args !== undefined) {
    args = snapshot.subagent ? decision.args : (await withEditedArgs(claimed, decision, toolRegistry, observed)).pending.args;
  }
  return {
    approved,
    ...(decision.note !== undefined && { note: decision.note }),
    ...(decision.remember !== undefined && { remember: decision.remember }),
    ...(args !== undefined && { args }),
    ...(isAutomaticDecision(decision) && { automatic: true as const }),
    ...(expired && { expired: true as const }),
    ...(observed.approver && { by: observed.approver }),
  };
}

/**
 * Eve TOOLS-F12: the session's 'awaiting-approval' checkpoint names the
 * approvals of the paused step that are still undecided, so a session,
 * channel or route sees what is left to decide.
 */
async function markGroupPending(snapshot: ExecutionSnapshot, paused: ExecutionResult, checkpointStore: CheckpointStore | undefined): Promise<void> {
  if (!snapshot.sessionId || !checkpointStore) return;
  const checkpoint = await checkpointStore.load(snapshot.sessionId);
  if (checkpoint?.status !== 'awaiting-approval') return;
  const ids = paused.approvalIds ?? [];
  const first = snapshot.approvalGroup?.find((member) => member.pending.id === ids[0])?.pending;
  const next: Checkpoint = { ...checkpoint, approvalId: ids[0] };
  if (ids.length > 1) next.approvalIds = ids;
  else delete next.approvalIds;
  const kind = first && describeApproval(first).kind;
  if (kind) next.approvalKind = kind;
  else delete next.approvalKind;
  await checkpointStore.save(snapshot.sessionId, next);
}

/**
 * Eve TOOLS-F12: runs a decided group's calls in call order - each approved
 * call like a single approved call, each rejected one with its rejection -
 * and records their results in the transcript. A call that needs sign-in
 * again pauses the run on it, the group's later calls waiting with it.
 */
async function runDecidedGroup(ctx: ResumeContext, group: ApprovalGroupMember[], drift?: AgentDrift): Promise<{ group: true } | { paused: ExecutionResult }> {
  const sink = runEventsOf(ctx.executeOptions as ExecuteOptions);
  sink?.runStart(ctx.snapshot.agent);
  if (drift) sink?.agentDrift(drift);
  for (const [index, member] of group.entries()) {
    // A call whose decision was lost is not run.
    const decided: GroupDecision = member.decision ?? { approved: false, note: 'not decided' };
    const decision: ApprovalDecision = {
      id: member.pending.id,
      approved: decided.approved,
      ...(decided.note !== undefined && { note: decided.note }),
      ...(decided.remember !== undefined && { remember: decided.remember }),
    };
    if (decided.automatic) markAutomaticDecision(decision);
    let pending = member.pending;
    if (decided.approved && decided.args) {
      pending = { ...pending, args: decided.args };
      ctx.messages.splice(0, ctx.messages.length, ...withCallArgs(ctx.messages, pending.toolCallId, decided.args));
    }
    const step = await streamedCall(
      { ...ctx, decision, approver: readonlyPrincipal(decided.by), expired: decided.expired === true, laterInGroup: group.slice(index + 1) },
      pending
    );
    if ('paused' in step) return step;
    if ('handoff' in step) throw new SDKError(`Approval '${pending.id}' is a handoff, which never pauses together with other calls.`, 'LOUSHO_CONFIG_INVALID');
    insertToolResult(ctx.messages, step.message);
  }
  return { group: true };
}

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

/** N9b: the rejection a declined or cancelled call gets: an expired pause, a sign-in, a question, or a tool call. */
function rejectionOf(pending: PendingApproval, expired: boolean = approvalExpired(pending)): { error: string; kind: 'denied' | 'rejected' } {
  const described = describeApproval(pending);
  // TTL: a pause decided after `expiresAt` denies, whatever kind it was.
  if (expired) {
    return { error: `Approval of '${described.toolName}' expired before it was decided`, kind: 'denied' };
  }
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
  const saved: ExecutionSnapshot = { ...snapshot, pendingToolCall: next, usage: structuredClone(ctx.usage) };
  // Eve TOOLS-F12: inside a decided group, the calls before this one already ran; the decided ones after it wait with it.
  const later = ctx.laterInGroup;
  if (later) {
    saved.currentMessages = [...ctx.messages];
    if (later.length > 0) saved.approvalGroup = [{ pending: next }, ...later];
    else delete saved.approvalGroup;
  }
  await ctx.approvalStore.save(next, saved);
  runEventsOf(executeOptions as ExecuteOptions)?.approvalRequested(next);
  return { paused: { text: '', messages: ctx.messages, toolCalls: [], usage: ctx.usage, finishReason: 'awaiting-approval', steps: snapshot.steps, approvalId: id, approvalIds: [id] } };
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
  run: { approvalStore: ApprovalStore; toolRegistry: ToolRegistry; provider: LLMProvider; executeOptions: ResumeExecuteOptions },
  putBack: ResolvedApproval = { pending, snapshot }
): Promise<AgentDrift | undefined> {
  const { agentFingerprint: saved } = snapshot;
  if (!saved) return undefined;
  const { toolRegistry, executeOptions } = run;
  const configured = snapshot.agent.tools ?? {};
  // Eve TOOLS-F12: a decided group runs every approved call of it.
  const group = snapshot.subagent ? undefined : snapshot.approvalGroup;
  const decided = group
    ? group.filter((member) => member.decision?.approved).map((member) => member.pending.toolName)
    : decision.approved && !snapshot.subagent
      ? [pending.toolName]
      : [];
  const calls = [...decided, ...(snapshot.remainingToolCalls ?? []).map((call) => call.function.name)];
  const missingTools = [...new Set(calls)].filter((name) => name in configured && !toolRegistry.get(name)?.tool);
  try {
    const current = await fingerprintOf(executeOptions.currentAgent ?? snapshot.agent, toolRegistry, run.provider, executeOptions.hostedTools);
    return checkAgentDrift({ saved, current, mode: executeOptions.onAgentDrift, missingTools });
  } catch (error) {
    await run.approvalStore.save(putBack.pending, putBack.snapshot);
    if (typeof error === 'object' && error !== null) refusedResumes.add(error);
    markPropagating(error);
    throw error;
  }
}

/**
 * decidedToolMessage(), reported on a streamed resume (LOU-V14) as the run's
 * `start` and the decided call's `tool.resume` / `tool.done` (`tool.error`)
 * events.
 */
async function streamedDecision(ctx: ResumeContext, pending: PendingApproval, drift?: AgentDrift): ReturnType<typeof decidedToolMessage> {
  const sink = runEventsOf(ctx.executeOptions as ExecuteOptions);
  if (!sink) return decidedToolMessage(ctx, pending);
  sink.runStart(ctx.snapshot.agent);
  if (drift) sink.agentDrift(drift);
  return streamedCall(ctx, pending);
}

/** The decided call of {@link streamedDecision}, reported as its `tool.resume` / `tool.done` (`tool.error`). */
async function streamedCall(ctx: ResumeContext, pending: PendingApproval): ReturnType<typeof decidedToolMessage> {
  const sink = runEventsOf(ctx.executeOptions as ExecuteOptions);
  if (!sink) return decidedToolMessage(ctx, pending);
  const call = ctx.snapshot.subagent ?? pending;
  const toolCall: ToolCall = {
    id: call.toolCallId,
    type: 'function',
    function: { name: call.toolName, arguments: JSON.stringify(call.args) },
  };
  // LOU-R17: the decided call's `tool.start` was emitted by the run that
  // paused; the continuation reports `tool.resume` so the call keeps exactly
  // one `tool.start` across the pause.
  sink.toolResume(toolCall);
  const step = await decidedToolMessage(ctx, pending);
  if ('message' in step) sink.toolSettled(toolResultOf(step.message));
  // N6: an approved transfer reports `tool.done` then `handoff`, like the switch in a live run.
  if ('handoff' in step) {
    sink.toolSettled({
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      result: step.handoff.result ?? { transferred_to: step.handoff.marker.to },
      ...(step.handoff.replacedByHook !== undefined && { replacedByHook: step.handoff.replacedByHook }),
    });
    sink.handoff({ ...step.handoff.marker, toolCallId: toolCall.id });
  }
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

/** The switch an approved handoff call completes: the target's run options and the transcript it sees. */
interface HandoffSwitch {
  options: ExecuteOptions;
  messages: Message[];
  marker: HandoffMarker;
  /** The routing result as the post-tool hooks left it (LOU-X3), for `tool.done`. */
  result?: unknown;
  replacedByHook?: string;
}

/**
 * The `tool` message for the decided call: the approved tool's result, the
 * rejection - or, when the run paused on a sub-agent, the sub-agent's final
 * answer after resuming it with the decision (LOU-Y1). N6: an approved
 * `transfer_to_*` call does not run a tool - it returns the completed switch.
 */
async function decidedToolMessage(
  ctx: ResumeContext,
  pending: PendingApproval
): Promise<{ message: Message } | { paused: ExecutionResult } | { handoff: HandoffSwitch }> {
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
    // Eve TOOLS-F12: a group's call was expired (or not) when it was decided.
    const expired = ctx.expired ?? approvalExpired(pending);
    const { error, kind } = rejectionOf(pending, expired);
    // TTL: an expiry denial is audited like a rule's `deny`.
    if (expired) {
      reportApprovalExpiry(executeOptions, {
        toolName: pending.toolName,
        toolCallId: pending.toolCallId,
        sessionId: contextSessionIdOf(snapshot),
        ...(executeOptions.principal && { principal: executeOptions.principal }),
        args: pending.args,
      });
    }
    return { message: toolResultMessage(pending, toolErrorResult({ toolName: pending.toolName, error, kind, details: { note: ctx.decision.note } }), true) };
  }
  // N6: a transfer call resumes by handing off, not by running a tool.
  const handoff = handoffNamed(executeOptions, pending.toolName);
  // N4: a call approved before a switch to plan mode does not run in plan mode.
  const { toolName, toolCallId, args } = pending;
  const { principal } = executeOptions;
  const toolDesc = ctx.toolRegistry.get(toolName) ?? (handoff ? handoffToolRegistry(executeOptions).get(toolName) : undefined);
  const planned = planModeRefusal(executeOptions, toolDesc, { toolName, toolCallId, sessionId: contextSessionIdOf(ctx.snapshot), ...(principal && { principal }), args });
  if (planned) {
    const error = `Tool '${toolName}' was denied by plan mode: ${planned}`;
    return { message: toolResultMessage(pending, toolErrorResult({ toolName, error, kind: 'denied', details: { reason: planned } }), true) };
  }
  if (handoff) return resumeHandoffCall(ctx, pending, handoff);
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
    message = await runApprovedInSpan(ctx, pending, scope, async () => {
      // N14: an approved `run_code` call runs its script, whose calls pass this run's gate (and are traced under its span).
      const registry = toolName === RUN_CODE_TOOL ? await approvedCodeMode(ctx, scope) : ctx.toolRegistry;
      return runApproved(pending, registry, scope, { id: pending.id, note: ctx.decision.note, ...(ctx.approver && { by: ctx.approver }) });
    });
  } catch (error) {
    if (!isSignInRequired(error)) throw error;
    return signInAgain(ctx, pending, error);
  }
  // LOU-X8: the transcript remembers the approval, for `once()`; Eve TOOLS-F19: whether a human gave it, and `remember`.
  const marker = approvalMarker(pending.args, { automatic: isAutomaticDecision(ctx.decision), remember: ctx.decision.remember });
  return { message: { ...message, metadata: { ...message.metadata, ...marker } } };
}

/**
 * N6: carries out an approved `transfer_to_*` call. Its pre-tool hooks re-run
 * on the approved arguments (LOU-X3.2: a hook may still deny it or supply its
 * result); a cleared call hands the run off exactly as the main loop would
 * (post hooks may rewrite the routing result the target reads). The caller
 * continues the run with `handoff.options`/`handoff.messages`.
 */
/**
 * The tool-call and hook context for a paused call's post-approval pass
 * (`resumedAfterApproval: true`, and a `hookArgs` copy hooks may not change
 * away from the approved args - LOU-X3.2 compares it with `pending.args`).
 * Shared by the tool-call and handoff-call resume paths.
 */
function resumedHookCall(
  ctx: Pick<ResumeContext, 'snapshot' | 'messages' | 'executeOptions'>,
  pending: PendingApproval
): { toolCall: ToolCall; hookArgs: Record<string, unknown>; hookCtx: ToolCallHookContext } {
  const { snapshot, messages, executeOptions } = ctx;
  const toolCall: ToolCall = {
    id: pending.toolCallId,
    type: 'function',
    function: { name: pending.toolName, arguments: JSON.stringify(pending.args) },
  };
  const hookArgs: Record<string, unknown> = structuredClone(pending.args);
  const hookCtx: ToolCallHookContext = {
    agentId: snapshot.agent.id,
    agentName: snapshot.agent.name,
    sessionId: contextSessionIdOf(snapshot),
    ...(executeOptions.principal && { principal: executeOptions.principal }),
    metadata: executeOptions.metadata,
    messages,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
    args: hookArgs,
    resumedAfterApproval: true,
    toolCall,
  };
  return { toolCall, hookArgs, hookCtx };
}

async function resumeHandoffCall(
  ctx: ResumeContext,
  pending: PendingApproval,
  handoff: ResolvedHandoff
): Promise<{ message: Message } | { handoff: HandoffSwitch }> {
  const { snapshot, messages, executeOptions } = ctx;
  const hooks: HookRegistry | undefined = executeOptions.hooks;
  const { toolCall, hookArgs, hookCtx } = resumedHookCall(ctx, pending);
  const verdict = hooks
    ? await runPreToolHooks(hooks, hookCtx, { toolRegistry: handoffToolRegistry(executeOptions), runtime: executeOptions, approvedArgs: pending.args })
    : { args: hookArgs };
  if (verdict.outcome) {
    const settled = settledByHook(verdict.outcome);
    const payload = { result: settled.errorResult ?? settled.result, error: settled.toolError };
    const replacedBy = hooks ? await hooks.runPostToolCall(hookCtx, payload) : undefined;
    const shown = replacedBy !== undefined ? payload.result : (settled.errorResult ?? settled.result);
    return { message: toolResultMessage(pending, shown, settled.errorResult !== undefined, replacedBy ?? settled.replacedByHook, executeOptions.maxToolResultChars) };
  }
  const options: ExecuteOptions = {
    ...executeOptions,
    agent: snapshot.agent,
    provider: ctx.provider,
    toolRegistry: ctx.toolRegistry,
    approvalStore: ctx.approvalStore,
    sessionId: snapshot.sessionId,
    ...(snapshot.contextSessionId !== undefined && { contextSessionId: snapshot.contextSessionId }),
    input: messages,
  };
  const state = { messages, agentName: activeAgentOf(messages) ?? snapshot.agent.name };
  const switched = await handOff(options, state, { handoff, toolCall, args: verdict.args, gatedAt: Date.now() }, extendRunOptions);
  const replaced = hooks
    ? await replaceHandoffResultByHook(hooks, hookCtx, switched, pending.toolCallId)
    : undefined;
  return { handoff: replaced ?? switched };
}

/** A post-tool hook may replace the transfer's result; the transcript tool message is rewritten to match. */
async function replaceHandoffResultByHook(
  hooks: HookRegistry,
  hookCtx: ToolCallHookContext,
  switched: HandoffSwitch,
  toolCallId: string
): Promise<HandoffSwitch | undefined> {
  const payload = { result: { transferred_to: switched.marker.to } };
  const hook = await hooks.runPostToolCall(hookCtx, payload);
  if (hook === undefined) return undefined;
  const written = switched.messages.find((m) => m.role === 'tool' && m.toolCallId === toolCallId);
  if (written) {
    written.content = toolResultContent(payload.result);
    written.metadata = { ...written.metadata, replacedByHook: hook };
  }
  return { ...switched, result: payload.result, replacedByHook: hook };
}

/**
 * #281: runs the approved call in an `execute_tool` span under the continued
 * run's `invoke_agent` span, with the content rules of the main loop's tool
 * spans (`captureContent`, `redactContent`). A call that needs sign-in again
 * is a pause, not a failure: its error ends outside the span.
 */
async function runApprovedInSpan(ctx: ResumeContext, pending: PendingApproval, scope: ToolCallScope, run: () => Promise<Message>): Promise<Message> {
  const { executeOptions, snapshot } = ctx;
  const { exporter, redactContent } = executeOptions;
  const init = toolSpanInit({ id: pending.toolCallId, name: pending.toolName }, { agent: executeOptions.currentAgent ?? snapshot.agent, toolRegistry: ctx.toolRegistry, sessionId: snapshot.sessionId });
  const outcome = await withSpan(
    exporter,
    init.name,
    init.attributes,
    async (span) => {
      scope.spanId = span.id;
      const startedAt = Date.now();
      try {
        const message = await run();
        const { result, error } = toolResultOf(message);
        recordToolOutcome(span, { args: pending.args, result, error, latencyMs: Date.now() - startedAt }, { redactContent, captureContent: resolveCaptureContent(executeOptions.captureContent) });
        return { message };
      } catch (error) {
        if (isSignInRequired(error)) return { signIn: error };
        throw error;
      }
    },
    ctx.runSpanId,
    init.kind
  );
  if ('signIn' in outcome) throw outcome.signIn;
  return outcome.message;
}

/**
 * N14: the registry a decided `run_code` call runs from (with the tool as the
 * run built it, when the run has code mode) and the inner-call runner bound
 * to `scope`. Without code mode, the registry as it is (the call then fails
 * as not found).
 */
async function approvedCodeMode(ctx: ResumeContext, scope: ToolCallScope): Promise<ToolRegistry> {
  const { executeOptions, snapshot } = ctx;
  if (!codeModeOf(executeOptions)) return ctx.toolRegistry;
  const agent = executeOptions.currentAgent ?? snapshot.agent;
  const run = { ...executeOptions, agent, provider: ctx.provider, toolRegistry: ctx.toolRegistry } as ExecuteOptions;
  const { deferral } = withToolSearch(run, agent, ctx.toolRegistry);
  const coded = await withCodeMode(run, agent, ctx.toolRegistry, deferral);
  const toolRegistry = coded.toolRegistry ?? ctx.toolRegistry;
  scope.callTool = nestedToolCaller({
    parentToolCallId: scope.toolCallId,
    parentSpanId: scope.spanId,
    base: {
      agent: coded.agent,
      toolRegistry,
      onToolCall: executeOptions.onToolCall,
      onToolResult: executeOptions.onToolResult,
      sandbox: executeOptions.sandbox ?? NoopSandbox,
      hooks: executeOptions.hooks,
      sessionId: contextSessionIdOf(snapshot),
      principal: executeOptions.principal,
      metadata: executeOptions.metadata,
      messages: ctx.messages,
      onDelegatedUsage: scope.onDelegatedUsage,
    },
    signal: executeOptions.signal,
    runtime: scope.runtime,
    execute: scope.execute,
    tracing: { exporter: executeOptions.exporter, redactContent: executeOptions.redactContent, captureContent: executeOptions.captureContent },
    concurrency: executeOptions.toolConcurrency ?? 'unbounded',
  });
  return toolRegistry;
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
 * When the continuation after an approval fails, the approved call's result
 * must not vanish with it: the stale pre-pause checkpoint was already deleted
 * (clearStaleCheckpoint) and the decided tool call already ran, so if the
 * continued execute() threw before its own first checkpoint write, nothing
 * recorded the result anywhere - the whole paused turn (the session's user
 * message, the call, its result) was lost and `pending()` came back null.
 *
 * Fix: write an 'in-progress' checkpoint holding the transcript the
 * continuation started from (decided call's result included), so a later
 * `execute()`/`session.resume()` on the same sessionId finishes the turn
 * instead of replaying or dropping it. Skipped when the continuation already
 * wrote a newer checkpoint before failing - that one holds the result too.
 *
 * This deliberately runs only AFTER the continued execute() rejects: writing
 * the checkpoint earlier would make that execute() rehydrate from it and
 * double its input transcript onto the checkpointed messages.
 */
async function keepTurnOnFailure(
  snapshot: ExecutionSnapshot,
  messages: Message[],
  checkpointStore: CheckpointStore | undefined,
  businessState: unknown,
  usage: RunUsage,
  continuation: () => Promise<ExecutionResult>
): Promise<ExecutionResult> {
  try {
    return await continuation();
  } catch (error) {
    try {
      if (snapshot.sessionId && checkpointStore && !(await checkpointStore.load(snapshot.sessionId))) {
        await checkpointStore.save(snapshot.sessionId, {
          agentId: snapshot.agent.id || '',
          sessionId: snapshot.sessionId,
          stepIndex: snapshot.steps,
          messages,
          toolCalls: [],
          usage: structuredClone(usage),
          businessState,
          status: 'in-progress',
          ...(snapshot.agentFingerprint && { agentFingerprint: snapshot.agentFingerprint }),
          ...(snapshot.agent.metadata?.[RUN_CONFIG_KEY] !== undefined && { runConfig: snapshot.agent.metadata[RUN_CONFIG_KEY] }),
          ...(snapshot.principal && { principal: snapshot.principal }),
          ...(snapshot.metadata !== undefined && { metadata: snapshot.metadata }),
        });
      }
    } catch {
      // A best-effort preserve: never mask the continuation's own error.
    }
    throw error;
  }
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
    ...(snapshot.metadata !== undefined && { metadata: snapshot.metadata }),
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
function toolResultMessage(pending: PendingApproval, payload: unknown, isError = false, replacedByHook?: string, maxChars?: number): Message {
  return {
    role: 'tool',
    content: toolResultContent(payload, maxChars),
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
  // LOU-X3.2 compares hookArgs with `pending.args`; the ctx is flagged so
  // stateful hooks can skip the re-fire (see resumedHookCall).
  const { hookArgs, hookCtx } = resumedHookCall({ snapshot, messages, executeOptions }, pending);

  // LOU-X3: a pre-hook may deny the call or supply its result; input it
  // supplies must match what the human approved.
  const verdict = hooks
    ? await runPreToolHooks(hooks, hookCtx, { toolRegistry, runtime: executeOptions, approvedArgs: pending.args })
    : { args: hookArgs };
  const settled: SettledCall = verdict.outcome
    ? settledByHook(verdict.outcome)
    : await executeApprovedTool(pending, toolDesc, verdict.args, executeOptions, { messages, approval, sessionId: contextSessionIdOf(snapshot) }, scope);
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
  return toolResultMessage(pending, shown, errorResult !== undefined, replacedBy ?? settled.replacedByHook, executeOptions.maxToolResultChars);
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
    // Mirror AgentExecutor.executeToolCall's handling of a thrown tool
    // error: errors that mark themselves as `PropagatingToolError` must
    // NOT be converted into a conversational {error} tool-result - that
    // would hand the LLM exactly the kind of "your tool call failed, try
    // again" signal that invites retrying an operation that must not be
    // retried. toolErrorMessage() rethrows those so they propagate out of
    // this function as a rejected promise instead, exactly like
    // AgentExecutor.executeToolCall does.
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

/** N13b: a streamed resume reports the decided call's snapshots as `tool.partial` (its `tool.resume` was reported by streamedDecision()). */
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
    agentSpanId: string;
  }
): Promise<ExecutionResult> {
  const { executeOptions } = run;
  return AgentExecutor.execute({
    ...executeOptions,
    agentSpanId: run.agentSpanId,
    agent: snapshot.agent,
    input: messages,
    provider: run.provider,
    toolRegistry: run.toolRegistry,
    sessionId: snapshot.sessionId,
    ...(snapshot.contextSessionId !== undefined && { contextSessionId: snapshot.contextSessionId }),
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

/** Eve DUI-F5: the session id the paused run's tools see (a session turn's session id, not its checkpoint key). */
function contextSessionIdOf(snapshot: ExecutionSnapshot): string | undefined {
  return snapshot.contextSessionId ?? snapshot.sessionId;
}
