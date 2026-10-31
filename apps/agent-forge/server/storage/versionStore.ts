/**
 * VersionStore - one workspace's append-only version history under
 * `.lousho/agents/<id>/versions/`.
 *
 * Layout (Contract B): `index.jsonl` carries one `VersionListItem` per line
 * (the index is the source of truth for numbering and listing);
 * `<NNNNNN>.json` carries the matching `VersionRecord` with the full
 * snapshot. Capture writes the record first and appends the index line
 * second, so a crash between the two leaves an orphan record file that the
 * next capture simply overwrites.
 *
 * Two non-obvious behaviors:
 * - A `kind: 'update'` capture whose spec hash and labels equal the latest
 *   version's is a no-op and returns `null` (autosave and explicit saves
 *   stay silent when nothing changed). Other kinds are never skipped.
 * - `reconcileExternalEdit` is called by writers before they overwrite
 *   `<id>.yaml`: when the file on disk matches neither any version's hash
 *   nor the `working.json` Studio-write marker, it was edited outside
 *   Studio and gets preserved as a `baseline` / `external_file_edit`
 *   version first.
 *
 * Lock-free like AgentRepo: callers serialize read-modify-write with
 * `withAgentLock(id)` (capture and reconcile never lock themselves, so a
 * caller already inside the lock can call them without re-entry).
 */
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { computeChangedFields } from '../../shared/specFields';
import type {
  SpecSnapshot,
  VersionKind,
  VersionListItem,
  VersionRecord,
  VersionSource,
} from '../../shared/wireTypes';
import type { AgentRepo } from './agentRepo';
import { readJsonFile, writeJsonAtomic } from './atomic';
import { specHash } from './specHash';

/** `requestText` (the Author message behind a version) is stored clamped to this many chars. */
const REQUEST_TEXT_MAX_CHARS = 400;

/** What a capture records beyond the snapshot itself; every omitted field lands on the item as `null`. */
export interface CaptureInput {
  kind: VersionKind;
  source: VersionSource;
  restoredFromVersion?: number | null;
  requestText?: string | null;
  authorSessionId?: string | null;
}

/**
 * `value` collapsed to a single-line, ≤ `max`-char string: whitespace runs
 * become one space, the ends are trimmed, and anything longer is cut to
 * `max - 1` chars plus '…'. `null` when nothing remains (or nothing was
 * given) - the version fields stay nullable rather than empty.
 */
function clampText(value: string | null | undefined, max: number): string | null {
  const collapsed = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (collapsed === '') return null;
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Same labels in the same order (label order is meaningful). */
function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((label, index) => label === b[index]);
}

/**
 * The version store over `repo`'s `.lousho/agents/<id>/versions/` trees.
 * `clock` is injectable for tests; it only stamps `createdAt`.
 */
export class VersionStore {
  constructor(
    private readonly repo: AgentRepo,
    private readonly clock: () => Date = () => new Date()
  ) {}

  private versionsDir(id: string): string {
    return path.join(this.repo.sidecarDir(id), 'versions');
  }

  private indexPath(id: string): string {
    return path.join(this.versionsDir(id), 'index.jsonl');
  }

  private recordPath(id: string, version: number): string {
    return path.join(this.versionsDir(id), `${String(version).padStart(6, '0')}.json`);
  }

  /**
   * Every index line, ascending by `version`. A crash can leave a partial
   * last line behind, so unparsable lines are warned about and skipped
   * rather than failing the whole history.
   */
  private async readIndex(id: string): Promise<VersionListItem[]> {
    let raw: string;
    try {
      raw = await fsPromises.readFile(this.indexPath(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const items: VersionListItem[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        items.push(JSON.parse(line) as VersionListItem);
      } catch {
        console.warn(`[agent-forge] skipping unparsable line in ${this.indexPath(id)}: ${line.slice(0, 80)}`);
      }
    }
    items.sort((a, b) => a.version - b.version);
    return items;
  }

  /** All version items for the agent, newest first; `[]` when it has none. */
  async list(agentId: string): Promise<VersionListItem[]> {
    return (await this.readIndex(agentId)).reverse();
  }

  /** The newest version item, or `undefined` when the agent has none. */
  async latest(agentId: string): Promise<VersionListItem | undefined> {
    return (await this.readIndex(agentId)).at(-1);
  }

  /** The full record (item + snapshot) of version `version`, `undefined` when absent. */
  async get(agentId: string, version: number): Promise<VersionRecord | undefined> {
    return readJsonFile<VersionRecord>(this.recordPath(agentId, version));
  }

  /**
   * Whether this capture is a no-op `update`: the spec hash matches the
   * latest version and the labels match that version's snapshot exactly
   * (same order). A missing latest record file means the labels cannot be
   * compared, so the version is written rather than guessed.
   */
  private isNoOpUpdate(
    input: CaptureInput,
    latest: VersionListItem | undefined,
    latestRecord: VersionRecord | undefined,
    snapshot: SpecSnapshot,
    hash: string
  ): boolean {
    if (input.kind !== 'update' || latest === undefined || latest.specHash !== hash) return false;
    if (latestRecord === undefined) return false;
    return sameLabels(latestRecord.snapshot.labels, snapshot.labels);
  }

  /** The index item for a capture: next version number, clamped text, null-filled optionals. */
  private buildItem(
    input: CaptureInput,
    latest: VersionListItem | undefined,
    before: SpecSnapshot | undefined,
    after: SpecSnapshot,
    hash: string
  ): VersionListItem {
    return {
      version: (latest?.version ?? 0) + 1,
      kind: input.kind,
      source: input.source,
      changedFields: computeChangedFields(before, after),
      restoredFromVersion: input.restoredFromVersion ?? null,
      summary: null,
      requestText: clampText(input.requestText, REQUEST_TEXT_MAX_CHARS),
      authorSessionId: input.authorSessionId ?? null,
      specHash: hash,
      createdAt: this.clock().toISOString(),
    };
  }

  /** Record file first, index append second: the index is the source of truth, an orphan record is overwritten next time. */
  private async persist(id: string, item: VersionListItem, snapshot: SpecSnapshot): Promise<void> {
    const record: VersionRecord = { ...item, snapshot };
    await writeJsonAtomic(this.recordPath(id, item.version), record);
    await fsPromises.appendFile(this.indexPath(id), `${JSON.stringify(item)}\n`);
  }

  /**
   * Snapshots the current working copy (spec + meta labels) as the next
   * version. Returns the written item, or `null` when the capture was a
   * no-op `update` (same spec hash and labels as the latest version).
   * Throws when the agent has no spec file. The caller must hold
   * `withAgentLock(agentId)` - this method never locks.
   */
  async capture(agentId: string, input: CaptureInput): Promise<VersionListItem | null> {
    const spec = await this.repo.readSpec(agentId);
    if (spec === undefined) throw new Error(`No saved agent '${agentId}'`);
    const snapshot: SpecSnapshot = { spec, labels: (await this.repo.readMeta(agentId)).labels };
    const hash = specHash(spec);

    const latest = (await this.readIndex(agentId)).at(-1);
    const latestRecord = latest === undefined ? undefined : await this.get(agentId, latest.version);
    if (this.isNoOpUpdate(input, latest, latestRecord, snapshot, hash)) return null;

    const item = this.buildItem(input, latest, latestRecord?.snapshot, snapshot, hash);
    await this.persist(agentId, item, snapshot);
    return item;
  }

  /**
   * Records a `baseline` / `external_file_edit` version for a working copy
   * that was not written by Studio: the file's spec hash matches no index
   * item and differs from the `working.json` Studio-write marker (or that
   * marker does not exist - which also baselines agents that predate
   * versioning). Returns `null` when there is nothing to reconcile: no spec
   * file, a Studio write, or a file identical to some known version. The
   * caller must hold `withAgentLock(agentId)` - this method never locks.
   */
  async reconcileExternalEdit(agentId: string): Promise<VersionListItem | null> {
    const spec = await this.repo.readSpec(agentId);
    if (spec === undefined) return null;
    const hash = specHash(spec);
    const items = await this.readIndex(agentId);
    if (items.some((item) => item.specHash === hash)) return null;
    if ((await this.repo.readWorkingHash(agentId)) === hash) return null;
    return this.capture(agentId, { kind: 'baseline', source: 'external_file_edit' });
  }
}
