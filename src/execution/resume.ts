/**
 * Resume execution of an agent after a human has decided on a pending
 * tool-call approval.
 */

import { LLMProvider, Message, ToolCall } from '../providers';
import { ToolRegistry } from '../tools';
import { ToolDescriptor } from '../types';
import {
  ApprovalDecision,
  ApprovalStore,
  ExecutionSnapshot,
  PendingApproval,
} from './ApprovalGate';
import { AgentExecutor, ExecuteOptions, ExecutionResult } from './AgentExecutor';
import { Checkpoint, CheckpointStore } from './checkpoint';
import { NoopSandbox } from '../security/sandboxCore';
import { executeToolWithSandboxGuard } from './sandboxGuard';
import { HookRegistry } from './hooks';
import { toolErrorMessage } from './propagatingToolError';
import { splitPendingTurn } from './transcript';

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
  | 'sessionId'
  | 'checkpointStore'
>;

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
export async function resumeAfterApproval(
  decision: ApprovalDecision,
  approvalStore: ApprovalStore,
  toolRegistry: ToolRegistry,
  provider: LLMProvider,
  executeOptions: ResumeExecuteOptions = {},
  checkpointStore?: CheckpointStore
): Promise<ExecutionResult> {
  const record = await approvalStore.resolve(decision.id);
  if (!record) {
    throw new Error(`No pending approval found for id '${decision.id}' (unknown or already resolved)`);
  }

  const { pending, snapshot } = record;
  const messages: Message[] = [...snapshot.currentMessages];

  const staleBusinessState = await clearStaleCheckpoint(snapshot.sessionId, checkpointStore);

  const toolMessage = decision.approved
    ? await runApprovedToolCall(pending, snapshot, messages, toolRegistry, executeOptions)
    : toolResultMessage(pending, {
        error: 'Tool execution was rejected by the reviewer',
        note: decision.note,
      }, true);
  messages.push(toolMessage);
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
  });
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
 * LOU-T1: reads the pre-pause checkpoint's businessState off before
 * deleting it (and returns it), so it can be carried forward into the
 * resumed run's own checkpoint-writes (see `businessState:` in
 * continueResumedRun()). This load is purely a data read - it does not
 * touch, and has no bearing on, the rehydration-safety delete immediately
 * after it.
 */
async function clearStaleCheckpoint(
  sessionId: string | undefined,
  checkpointStore: CheckpointStore | undefined
): Promise<unknown> {
  if (!sessionId || !checkpointStore) {
    return undefined;
  }
  const staleCheckpoint: Checkpoint | null = await checkpointStore.load(sessionId);
  await checkpointStore.delete(sessionId);
  return staleCheckpoint?.businessState;
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
      content: JSON.stringify({
        error: 'Tool call was not run: the run paused for approval before reaching it and this approval was saved without its remaining calls',
      }),
      name: call.function.name,
      toolCallId: call.id,
      toolName: call.function.name,
      isError: true,
    });
  }
}

/** The `tool` message carrying a resumed tool call's result (or rejection). */
function toolResultMessage(pending: PendingApproval, payload: unknown, isError = false): Message {
  return {
    role: 'tool',
    content: JSON.stringify(payload),
    name: pending.toolName,
    toolCallId: pending.toolCallId,
    toolName: pending.toolName,
    ...(isError && { isError }),
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
  executeOptions: ResumeExecuteOptions
): Promise<Message> {
  const toolDesc = toolRegistry.get(pending.toolName);
  // A `requiresSandbox` tool may have no `tool.execute` implementation at
  // all - its real work happens in `sandboxExecute()` instead - so the
  // "not found" guard below must not reject that case outright; it only
  // means there is genuinely no way to run the tool (neither a direct
  // `execute` nor a `sandboxExecute`).
  if (!toolDesc || !toolDesc.tool || (!toolDesc.tool.execute && !toolDesc.sandboxExecute)) {
    throw new Error(`Tool '${pending.toolName}' not found in registry`);
  }

  // LOU-Q1: hooks must fire for this deferred, post-approval execution
  // path too - not just AgentExecutor's own main-loop tool call site -
  // since this is a genuine, independent point where a tool actually
  // runs. `args` is a mutable object a `preToolCall` hook (e.g.
  // redact-pii) can rewrite in place before the real execution below, the
  // same contract AgentExecutor.executeToolCall() offers.
  const hooks: HookRegistry | undefined = executeOptions.hooks;
  const hookArgs: Record<string, unknown> = { ...pending.args };
  const hookCtx = {
    agentId: snapshot.agent.id,
    agentName: snapshot.agent.name,
    sessionId: snapshot.sessionId,
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

  if (hooks) {
    await hooks.runPreToolCall(hookCtx);
  }

  const { result, toolError } = await executeApprovedTool(pending, toolDesc, hookArgs, executeOptions);

  // Fires (with the settled result/error) regardless of how the tool
  // settled - matching AgentHook.postToolCall's documented contract
  // ("Invoked immediately after a tool call settles (success, tool-level
  // error, or approval-required)"). Deliberately OUTSIDE
  // executeApprovedTool()'s try/catch: a throw here is a hook error, not a
  // tool error, and must propagate out of resumeAfterApproval() unconverted
  // (see executeApprovedTool()).
  if (hooks) {
    await hooks.runPostToolCall(hookCtx, { result, error: toolError });
  }

  return toolResultMessage(pending, toolError ? { error: toolError } : result, Boolean(toolError));
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
  executeOptions: ResumeExecuteOptions
): Promise<{ result: unknown; toolError?: string }> {
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
        pending.toolCallId
      ),
    };
  } catch (error) {
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
    // Uses the same `(error as Error).message` extraction AgentExecutor's
    // catch block uses, wrapped in the `{error}`-shaped payload the
    // rejection branch of resumeAfterApproval() already uses for
    // non-approved decisions.
    return { result: undefined, toolError: toolErrorMessage(error) };
  }
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
  });
}
