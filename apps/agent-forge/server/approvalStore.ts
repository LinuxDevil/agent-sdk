/**
 * File-backed `ApprovalStore` (src/execution/ApprovalGate.ts, public SDK
 * API) for the LOU-N runtime control server, persisting pending approvals
 * under `<baseDir>/.lousho/agents/<agentId>/approvals/<approvalId>.json`.
 *
 * Sibling to FileCheckpointStore.ts - see its doc comment for why this is a
 * separate store rather than extending fsAgentStore.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval, ResolvedApproval } from '@lousho/build-ai-agent';

export class FileApprovalStore implements ApprovalStore {
  constructor(private readonly baseDir: string) {}

  private dir(agentId: string): string {
    return path.join(this.baseDir, '.lousho', 'agents', agentId, 'approvals');
  }

  private filePath(agentId: string, approvalId: string): string {
    return path.join(this.dir(agentId), `${approvalId}.json`);
  }

  async save(pending: PendingApproval, snapshot: ExecutionSnapshot): Promise<void> {
    const agentId = pending.agentId || 'unknown';
    fs.mkdirSync(this.dir(agentId), { recursive: true });
    const record: ResolvedApproval = { pending, snapshot };
    fs.writeFileSync(this.filePath(agentId, pending.id), JSON.stringify(record), 'utf8');
  }

  /**
   * `resolve()` is delete-on-read (matching StorageServiceApprovalStore's
   * documented contract) but the on-disk layout is per-agent, so this scans
   * every agent's approvals directory for a matching `<approvalId>.json`.
   * The registry (runRegistry.ts) always calls this with the agentId it
   * already knows in hand via a narrower `resolveFor()` below, which avoids
   * the scan in the common case - this full scan is a fallback for the
   * generic `ApprovalStore` interface contract (e.g. direct SDK use).
   */
  async resolve(approvalId: string): Promise<ResolvedApproval | null> {
    const agentsDir = path.join(this.baseDir, '.lousho', 'agents');
    if (!fs.existsSync(agentsDir)) return null;
    for (const agentId of fs.readdirSync(agentsDir)) {
      const found = await this.resolveFor(agentId, approvalId);
      if (found) return found;
    }
    return null;
  }

  async resolveFor(agentId: string, approvalId: string): Promise<ResolvedApproval | null> {
    const file = this.filePath(agentId, approvalId);
    if (!fs.existsSync(file)) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as ResolvedApproval;
    fs.unlinkSync(file);
    return record;
  }

  /** Reads a saved approval record without deleting it (runRegistry.ts uses this to render the pending-approval card). */
  async peek(agentId: string, approvalId: string): Promise<ResolvedApproval | null> {
    const file = this.filePath(agentId, approvalId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ResolvedApproval;
  }

  /** `ApprovalStore.load` (#280): like `resolve`, it scans every agent's approvals directory for the id, but does not delete. */
  async load(approvalId: string): Promise<ResolvedApproval | null> {
    const agentsDir = path.join(this.baseDir, '.lousho', 'agents');
    if (!fs.existsSync(agentsDir)) return null;
    for (const agentId of fs.readdirSync(agentsDir)) {
      const found = await this.peek(agentId, approvalId);
      if (found) return found;
    }
    return null;
  }
}
