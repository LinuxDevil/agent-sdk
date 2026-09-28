/**
 * Resume execution of an agent after a human has decided on a pending
 * tool-call approval.
 */

import { LLMProvider, Message } from '../providers';
import { ToolRegistry } from '../tools';
import { ApprovalDecision, ApprovalStore } from './ApprovalGate';
import { AgentExecutor, ExecuteOptions, ExecutionResult, PropagatingToolError } from './AgentExecutor';
import { CheckpointStore } from './checkpoint';
import { NoopSandbox } from '../security/sandboxCore';
import { executeToolWithSandboxGuard } from './sandboxGuard';

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

  // Defense in depth: a checkpoint under this sessionId (if any) was
  // written before this pause and is therefore stale by construction -
  // clear it now so it can't be loaded by this resume or by some later,
  // unrelated execute() call against the same sessionId+checkpointStore.
  //
  // Doing this BEFORE the AgentExecutor.execute() call below (rather than
  // just relying on `skipSystemPromptInjection`/`initialSteps` to make a
  // rehydration "harmless") is what makes it safe to pass sessionId and
  // checkpointStore through to that call: its rehydration branch only
  // triggers when `checkpointStore.load(sessionId)` finds something, and
  // by the time it runs (synchronously after this delete resolves, with no
  // intervening await back to caller code) there is nothing left to find.
  //
  // Accepted race: if some OTHER process/caller writes a new checkpoint
  // under this exact sessionId in the narrow window between this delete
  // and the execute() call's load(), that checkpoint would be picked up
  // instead of the freshly-reconstructed messages. This mirrors how
  // ApprovalStore.resolve() above is documented as delete-on-read without
  // an additional distributed lock (see the catch block below) - this
  // codebase accepts same-sessionId-concurrent-caller races as an existing
  // caller-responsibility invariant (a sessionId identifies a single
  // logical run) rather than adding cross-process locking to CheckpointStore.
  if (snapshot.sessionId && checkpointStore) {
    await checkpointStore.delete(snapshot.sessionId);
  }

  if (decision.approved) {
    const toolDesc = toolRegistry.get(pending.toolName);
    // A `requiresSandbox` tool may have no `tool.execute` implementation at
    // all - its real work happens in `sandboxExecute()` instead - so the
    // "not found" guard below must not reject that case outright; it only
    // means there is genuinely no way to run the tool (neither a direct
    // `execute` nor a `sandboxExecute`).
    if (!toolDesc || !toolDesc.tool || (!toolDesc.tool.execute && !toolDesc.sandboxExecute)) {
      throw new Error(`Tool '${pending.toolName}' not found in registry`);
    }

    try {
      // Mirrors AgentExecutor.executeToolCall()'s fail-closed handling of
      // `requiresSandbox` tools (LOU-F5) via the shared
      // executeToolWithSandboxGuard() helper (LOU-F fix), so a deferred
      // tool executed after human approval can't silently bypass the
      // sandbox seam the way it previously did.
      const sandbox = executeOptions.sandbox ?? NoopSandbox;
      const result = await executeToolWithSandboxGuard(pending.toolName, toolDesc, pending.args, sandbox);

      messages.push({
        role: 'tool',
        content: JSON.stringify(result),
        name: pending.toolName,
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
      });
    } catch (error) {
      // Mirror AgentExecutor.executeToolCall's (post-fix) handling of a
      // thrown tool error: errors that mark themselves as
      // `PropagatingToolError` (e.g. DelegationDepthExceededError) must NOT
      // be converted into a conversational {error} tool-result - that would
      // hand the LLM exactly the kind of "your tool call failed, try again"
      // signal that triggers another delegation attempt, defeating the
      // whole point of the depth guard. Rethrow so it propagates out of
      // this function as a rejected promise instead, exactly like
      // AgentExecutor.executeToolCall does.
      if (error instanceof PropagatingToolError) {
        throw error;
      }

      // Every other thrown tool error is turned into a graceful tool-result
      // message instead of letting it reject this promise. By this point
      // the pending-approval record has already been deleted
      // (ApprovalGate.resolve() is delete-on-read), so failing to catch
      // here would mean the whole resume just fails with no retry path.
      // Uses the same `(error as Error).message` extraction AgentExecutor's
      // catch block uses, wrapped in the `{error}`-shaped payload this
      // file's own rejection branch (below) already uses for non-approved
      // decisions.
      messages.push({
        role: 'tool',
        content: JSON.stringify({ error: (error as Error).message }),
        name: pending.toolName,
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
      });
    }
  } else {
    messages.push({
      role: 'tool',
      content: JSON.stringify({
        error: 'Tool execution was rejected by the reviewer',
        note: decision.note,
      }),
      name: pending.toolName,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
    });
  }

  return AgentExecutor.execute({
    ...executeOptions,
    agent: snapshot.agent,
    input: messages,
    provider,
    toolRegistry,
    // LOU-K5: thread sessionId/checkpointStore through so AgentExecutor
    // resumes writing per-tool-result checkpoints for the rest of this run
    // (previously both were forced to `undefined` here, which also killed
    // forward checkpointing for the whole remainder of the resumed run -
    // not just the resume step itself). `snapshot.sessionId` and this
    // function's own `checkpointStore` parameter are used explicitly here
    // rather than whatever (if anything) `executeOptions` carries, since
    // `ResumeExecuteOptions` omits both fields - see that type's doc
    // comment. This still can't rehydrate stale state: the stale
    // pre-pause checkpoint under `snapshot.sessionId` was just deleted
    // above, so AgentExecutor.execute()'s `checkpointStore.load(sessionId)`
    // rehydration check finds nothing and falls into its normal
    // "build from scratch" path, using exactly the `input`/
    // `skipSystemPromptInjection`/`initialSteps` reconstructed below - it
    // never re-triggers the rehydration branch this guard used to worry
    // about. When no `checkpointStore` was passed to resumeAfterApproval()
    // at all, this is `undefined` and AgentExecutor.execute() behaves
    // exactly as it always has for callers that don't use durable
    // execution.
    sessionId: snapshot.sessionId,
    checkpointStore,
    // `messages` was reconstructed from the ExecutionSnapshot's
    // currentMessages, which already include the original system message
    // (if any) that AgentExecutor.buildMessages() built the first time
    // this agent ran. Because the stale checkpoint was just deleted above,
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
