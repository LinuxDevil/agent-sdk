/**
 * Resume execution of an agent after a human has decided on a pending
 * tool-call approval.
 */

import { LLMProvider, Message } from '../providers';
import { ToolRegistry } from '../tools';
import { ApprovalDecision, ApprovalStore } from './ApprovalGate';
import { AgentExecutor, ExecuteOptions, ExecutionResult, PropagatingToolError } from './AgentExecutor';
import { CheckpointStore } from './checkpoint';

/**
 * Options passed through to the underlying AgentExecutor.execute() call
 * once the deferred tool result (or rejection) has been appended to the
 * conversation.
 *
 * `sessionId`/`checkpointStore` are also omitted here (in addition to the
 * fields already omitted below): the resume path always fully reconstructs
 * `messages`/`steps` from the ApprovalGate's ExecutionSnapshot, so it must
 * never delegate to AgentExecutor's checkpoint-rehydration mechanism. Any
 * checkpoint that exists under a given sessionId at this point was written
 * BEFORE the pause (checkpoints are only saved after a tool *result*, and a
 * pause happens before the deferred tool runs), so it is stale by
 * construction and would silently clobber the just-reconstructed messages
 * (including the deferred tool's own result) and step count if allowed
 * through. See resumeAfterApproval() below for the belt-and-suspenders
 * runtime guard that backs this type-level omission.
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
 * @param checkpointStore Optional durable-execution CheckpointStore. This
 * is NOT threaded through to the follow-up execute() call (see
 * ResumeExecuteOptions) - it is used only, when the paused run's
 * ExecutionSnapshot carries a sessionId, to proactively delete the stale
 * checkpoint left behind under that sessionId from before the pause. This
 * closes the gap for a LATER, unrelated execute() call against the same
 * sessionId+checkpointStore (one that doesn't go through resume at all)
 * so it can't silently rehydrate that stale pre-pause state either.
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
  if (snapshot.sessionId && checkpointStore) {
    await checkpointStore.delete(snapshot.sessionId);
  }

  if (decision.approved) {
    const toolDesc = toolRegistry.get(pending.toolName);
    if (!toolDesc || !toolDesc.tool || !toolDesc.tool.execute) {
      throw new Error(`Tool '${pending.toolName}' not found in registry`);
    }

    try {
      const result = await toolDesc.tool.execute(pending.args, {} as any);

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
    // Belt-and-suspenders runtime guard backing the ResumeExecuteOptions
    // type-level Omit above: `Omit<...>` only stops *type-checked* callers
    // from passing sessionId/checkpointStore through executeOptions - it
    // does nothing to stop a caller who bypasses the type (e.g. an `as
    // any` cast, or a plain-JS caller) from putting them on the object at
    // runtime, where `...executeOptions` would otherwise spread them
    // straight into this call. Explicitly forcing both to undefined here,
    // after the spread, guarantees AgentExecutor.execute() can never fall
    // into its checkpoint-rehydration branch for a resume, regardless of
    // what executeOptions actually contains.
    sessionId: undefined,
    checkpointStore: undefined,
    // `messages` was reconstructed from the ExecutionSnapshot's
    // currentMessages, which already include the original system message
    // (if any) that AgentExecutor.buildMessages() built the first time
    // this agent ran. Since no checkpoint/sessionId is threaded through
    // this call, execute() would otherwise fall into its "build from
    // scratch" path and prepend a second, duplicate system message built
    // fresh from agent.prompt.
    skipSystemPromptInjection: true,
    // Continue step-budget accounting from where the paused run left off,
    // rather than silently resetting to a full fresh maxSteps allowance.
    // snapshot.steps is the step count AgentExecutor.execute() had already
    // reached (see ExecutionSnapshot) at the moment it paused for approval.
    initialSteps: snapshot.steps,
  });
}
