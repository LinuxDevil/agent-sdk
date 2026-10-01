/**
 * In-memory ApprovalStore (LOU-D21): the default store of `createAgent()`
 * agents. Pending approvals live only as long as the process; pass a durable
 * store (`StorageServiceApprovalStore`, `SqliteStore.approvals`) to resume
 * after a restart.
 */

import type { ApprovalStore, ExecutionSnapshot, PendingApproval, ResolvedApproval } from './ApprovalGate';

/**
 * Keeps pending approvals in a Map. Records are copied on save, so later
 * changes to the paused run's messages do not leak into the snapshot.
 *
 * @example
 * ```ts
 * const approvalStore = new InMemoryApprovalStore();
 * const paused = await AgentExecutor.execute({ agent, input, provider, toolRegistry, approvalStore });
 * ```
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ResolvedApproval>();

  async save(pending: PendingApproval, snapshot: ExecutionSnapshot): Promise<void> {
    this.records.set(pending.id, structuredClone({ pending, snapshot }));
  }

  async resolve(id: string): Promise<ResolvedApproval | null> {
    const record = this.records.get(id);
    if (!record) return null;
    this.records.delete(id);
    return record;
  }
}
