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
 *
 * LOU-D45: also keeps the bounded per-session `history()` ring the SDK's
 * `LocalStorageCheckpointStore` keeps (same helpers, same semantics), under
 * `.loushy/agents/<agentId>/checkpoint-history/<sessionId>.json`, so the
 * time-travel panel can list a run's steps and `AgentExecutor.fork()` can
 * fork from any of them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  appendToRing,
  newestFirst,
  resolveHistoryLimit,
  toHistoryEntry,
  type Checkpoint,
  type CheckpointDeleteOptions,
  type CheckpointHistoryEntry,
  type CheckpointHistoryOptions,
  type CheckpointStore,
} from '@loushy/build-ai-agent';

/** Write to a temp file and rename it over `file`, so a crash never leaves half a file there. */
function writeFileAtomic(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, file);
}

export class FileCheckpointStore implements CheckpointStore {
  private readonly historyLimit: number;

  /** @param options.historyLimit checkpoints kept per session in `history()` (default 50, `0` keeps none) */
  constructor(
    private readonly baseDir: string,
    options: { historyLimit?: number } = {}
  ) {
    this.historyLimit = resolveHistoryLimit(options.historyLimit);
  }

  private dir(agentId: string, kind = 'checkpoints'): string {
    return path.join(this.baseDir, '.loushy', 'agents', agentId, kind);
  }

  private filePath(agentId: string, sessionId: string, kind?: string): string {
    return path.join(this.dir(agentId, kind), `${sessionId}.json`);
  }

  private historyPath(sessionId: string): string {
    return this.filePath(this.agentIdFromSessionId(sessionId), sessionId, 'checkpoint-history');
  }

  private readRing(sessionId: string): CheckpointHistoryEntry[] {
    const file = this.historyPath(sessionId);
    if (!fs.existsSync(file)) return [];
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as CheckpointHistoryEntry[];
    } catch {
      return []; // a partially written file (a crash mid-write) counts as no history
    }
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
    writeFileAtomic(this.filePath(agentId, sessionId), JSON.stringify(checkpoint));
    if (this.historyLimit > 0) {
      const ring = appendToRing(this.readRing(sessionId), toHistoryEntry(checkpoint), this.historyLimit);
      fs.mkdirSync(this.dir(agentId, 'checkpoint-history'), { recursive: true });
      writeFileAtomic(this.historyPath(sessionId), JSON.stringify(ring));
    }
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    const agentId = this.agentIdFromSessionId(sessionId);
    const file = this.filePath(agentId, sessionId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Checkpoint;
  }

  async delete(sessionId: string, options: CheckpointDeleteOptions = {}): Promise<void> {
    const agentId = this.agentIdFromSessionId(sessionId);
    fs.rmSync(this.filePath(agentId, sessionId), { force: true });
    if (!options.keepHistory) fs.rmSync(this.historyPath(sessionId), { force: true });
  }

  async history(sessionId: string, options?: CheckpointHistoryOptions): Promise<CheckpointHistoryEntry[]> {
    return newestFirst(this.readRing(sessionId), options);
  }
}
