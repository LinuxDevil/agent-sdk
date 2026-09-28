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
export type ResumeExecuteOptions = Omit<ExecuteOptions, 'agent' | 'input' | 'provider' | 'toolRegistry'>;

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

    const result = await toolDesc.tool.execute(pending.args, {} as any);

    messages.push({
      role: 'tool',
      content: JSON.stringify(result),
      name: pending.toolName,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
    });
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
  });
}
