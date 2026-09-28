/**
 * Resume execution of an agent after a human has decided on a pending
 * tool-call approval.
 */

import { LLMProvider, Message } from '../providers';
import { ToolRegistry } from '../tools';
import { ApprovalDecision, ApprovalStore } from './ApprovalGate';
import { AgentExecutor, ExecuteOptions, ExecutionResult } from './AgentExecutor';

/**
 * Options passed through to the underlying AgentExecutor.execute() call
 * once the deferred tool result (or rejection) has been appended to the
 * conversation.
 */
export type ResumeExecuteOptions = Omit<
  ExecuteOptions,
  'agent' | 'input' | 'provider' | 'toolRegistry' | 'skipSystemPromptInjection' | 'initialSteps'
>;

/**
 * Resume a paused AgentExecutor run after a human approves or rejects the
 * tool call it was waiting on.
 *
 * Deviation from the ticket snippet: AgentExecutor exposes only a static
 * `execute()` method (there is no instantiable AgentExecutor to inject),
 * so this takes the LLMProvider needed to keep generating instead of an
 * `executor: AgentExecutor` instance.
 */
export async function resumeAfterApproval(
  decision: ApprovalDecision,
  approvalStore: ApprovalStore,
  toolRegistry: ToolRegistry,
  provider: LLMProvider,
  executeOptions: ResumeExecuteOptions = {}
): Promise<ExecutionResult> {
  const record = await approvalStore.resolve(decision.id);
  if (!record) {
    throw new Error(`No pending approval found for id '${decision.id}' (unknown or already resolved)`);
  }

  const { pending, snapshot } = record;
  const messages: Message[] = [...snapshot.currentMessages];

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
      // Mirror AgentExecutor.executeToolCall's handling of a thrown tool
      // error: turn it into a graceful tool-result message instead of
      // letting it reject this promise. By this point the pending-approval
      // record has already been deleted (ApprovalGate.resolve() is
      // delete-on-read), so failing to catch here would mean the whole
      // resume just fails with no retry path. Uses the same
      // `(error as Error).message` extraction AgentExecutor's catch block
      // uses, wrapped in the `{error}`-shaped payload this file's own
      // rejection branch (below) already uses for non-approved decisions.
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
