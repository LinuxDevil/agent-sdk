// approvals.md:409
import { AgentExecutor, resumeAfterApproval } from '@lousho/build-ai-agent/executor';
import { StorageServiceApprovalStore } from '@lousho/build-ai-agent/utils';

const approvalStore = new StorageServiceApprovalStore(storage);

const paused = await AgentExecutor.execute({
  agent, input, provider, toolRegistry, approvalStore,
});
// paused.finishReason === 'awaiting-approval', paused.approvalId is set

// ...later, from any process, after a human approves...
const result = await resumeAfterApproval(
  { id: paused.approvalId!, approved: true },
  approvalStore,
  toolRegistry,
  provider,
);
export {};
