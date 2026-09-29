/**
 * File-backed `CheckpointStore` (src/execution/checkpoint.ts, public SDK
 * API) for the LOU-N runtime control server, persisting under
 * `<baseDir>/.loushy/agents/<agentId>/checkpoints/<sessionId>.json`.
 *
 * This is exactly the seam LOU-L's `createFsAgentStore()` TODO pointed at
 * ("wire this up behind the runtime control server"): a sibling store next
 * to it, following the same `.loushy/agents/<id>/...` layout, rather than
 * extending fsAgentStore.ts itself (agent specs and run checkpoints are
 * different lifecycles/read-write patterns, so separate files/stores).
 *
 * Consumes only the public `CheckpointStore` interface - no SDK internals.
 *
 * LOU-T1: `Checkpoint.businessState` needs no changes here - `save()`/
 * `load()` already serialize/deserialize the whole `Checkpoint` record
 * verbatim via `JSON.stringify`/`JSON.parse`, so any JSON-serializable
 * `businessState` a consumer attaches round-trips through this store for
 * free, exactly like every other field.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Checkpoint, CheckpointStore } from '@loushy/build-ai-agent';

export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly baseDir: string) {}

  private dir(agentId: string): string {
    return path.join(this.baseDir, '.loushy', 'agents', agentId, 'checkpoints');
  }

  private filePath(agentId: string, sessionId: string): string {
    return path.join(this.dir(agentId), `${sessionId}.json`);
  }

  /**
   * `CheckpointStore.save/load/delete` are keyed by `sessionId` alone (see
   * src/execution/checkpoint.ts), but this store's on-disk layout is
   * per-agent (`.loushy/agents/<agentId>/checkpoints/`). Sessions in this
   * server are always created as `${agentId}:${runNumber}` (see
   * runRegistry.ts), so the agentId is recovered by splitting on the first
   * `:` - this keeps the public `CheckpointStore` interface unchanged while
   * still getting the per-agent directory layout the ticket asks for.
   */
  private agentIdFromSessionId(sessionId: string): string {
    const idx = sessionId.indexOf(':');
    return idx === -1 ? sessionId : sessionId.slice(0, idx);
  }

  async save(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    const agentId = this.agentIdFromSessionId(sessionId);
    fs.mkdirSync(this.dir(agentId), { recursive: true });
    fs.writeFileSync(this.filePath(agentId, sessionId), JSON.stringify(checkpoint), 'utf8');
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    const agentId = this.agentIdFromSessionId(sessionId);
    const file = this.filePath(agentId, sessionId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Checkpoint;
  }

  async delete(sessionId: string): Promise<void> {
    const agentId = this.agentIdFromSessionId(sessionId);
    const file = this.filePath(agentId, sessionId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
