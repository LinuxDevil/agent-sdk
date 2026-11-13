/**
 * DraftStore - one workspace's change drafts under
 * `.lousho/agents/<id>/drafts/`.
 *
 * Layout (Contract B): `current.json` holds the at-most-one pending
 * `ChangeDraft`; every draft that leaves pending - approved, rejected, or
 * withdrawn by a newer create - moves to `history/<draftId>.json` with its
 * final status and `respondedAt` stamped. Draft ids are `randomUUID()`s.
 *
 * `applySpecPatch` is the pure half: it turns a draft's `SpecPatch` into
 * the `{ spec, labels }` snapshot the patch would produce, so routes can
 * validate and diff the result before anything touches disk.
 *
 * Lock-free like AgentRepo and VersionStore: callers serialize
 * read-modify-write with `withAgentLock(id)`; the store only does atomic
 * file IO (create/settle write through `writeJsonAtomic`).
 */
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type {
  ChangeDraft,
  DraftFieldClasses,
  DraftOrigin,
  DraftStatus,
  SpecPatch,
  SpecSnapshot,
} from '../../shared/wireTypes';
import type { AgentRepo } from './agentRepo';
import { readJsonFile, writeJsonAtomic } from './atomic';
import { stableStringify } from '../../shared/stableJson';
import { draftFingerprint } from '../lifecycle/draftFields';

/**
 * The `draftId` a settle call named is not the current pending draft - a
 * sheet left open while the draft was replaced. Routes answer 409.
 */
export class DraftMismatchError extends Error {
  // fallow-ignore-next-line unused-class-member -- read as `error.code` under instanceof narrowing in routes/draftRoutes.ts's sendDraftStoreError, which fallow's import graph does not register
  readonly code = 'LOUSHO_DRAFT_STALE';
  constructor(agentId: string, draftId: string) {
    super(`Draft '${draftId}' is not the current pending draft for agent '${agentId}'`);
    this.name = 'DraftMismatchError';
  }
}

/** The agent has no pending draft to settle. Routes answer 404. */
export class NoDraftError extends Error {
  readonly code = 'LOUSHO_DRAFT_NOT_FOUND';
  constructor(agentId: string) {
    super(`No pending draft for agent '${agentId}'`);
    this.name = 'NoDraftError';
  }
}

/** Everything `create` needs; the store stamps id, timestamps and the pending bookkeeping fields itself. */
export interface NewDraftInput {
  patch: SpecPatch;
  origin: DraftOrigin;
  reason: string;
  baseVersion: number | null;
  baseSpecHash: string;
}

/** What {@link DraftStore.update} may change on the pending draft. */
export interface DraftUpdate {
  patch?: SpecPatch;
  reason?: string;
}

/** Called after a draft's `current.json` write that created it or changed its patch/reason (never for review bookkeeping). */
export type DraftWrittenListener = (agentId: string, draft: ChangeDraft) => void;

/** The draft store over `repo`'s `.lousho/agents/<id>/drafts/` trees. `clock` is injectable for tests. */
export class DraftStore {
  private readonly writtenListeners = new Set<DraftWrittenListener>();

  constructor(
    private readonly repo: AgentRepo,
    private readonly clock: () => Date = () => new Date()
  ) {}

  private draftsDir(id: string): string {
    return path.join(this.repo.sidecarDir(id), 'drafts');
  }

  private currentPath(id: string): string {
    return path.join(this.draftsDir(id), 'current.json');
  }

  private historyDir(id: string): string {
    return path.join(this.draftsDir(id), 'history');
  }

  private historyPath(id: string, draftId: string): string {
    return path.join(this.historyDir(id), `${draftId}.json`);
  }

  /** Moves `draft` into history with `status`, stamping `respondedAt`/`updatedAt` with the clock. */
  private async settleToHistory(agentId: string, draft: ChangeDraft, status: Exclude<DraftStatus, 'pending'>, note: string | null): Promise<ChangeDraft> {
    const now = this.clock().toISOString();
    const settled: ChangeDraft = { ...draft, status, note, respondedAt: now, updatedAt: now };
    await writeJsonAtomic(this.historyPath(agentId, draft.id), settled);
    return settled;
  }

  /** The agent's pending draft, or `undefined` when it has none. */
  async current(agentId: string): Promise<ChangeDraft | undefined> {
    return readJsonFile<ChangeDraft>(this.currentPath(agentId));
  }

  /**
   * Writes a new pending draft to `current.json`. When a pending draft
   * already exists it is first moved to history as `withdrawn` (at most
   * one pending draft per agent) and returned as `replaced`.
   */
  async create(agentId: string, input: NewDraftInput): Promise<{ draft: ChangeDraft; replaced: ChangeDraft | null }> {
    const now = this.clock().toISOString();
    let replaced: ChangeDraft | null = null;
    const prev = await this.current(agentId);
    if (prev !== undefined) {
      replaced = await this.settleToHistory(agentId, prev, 'withdrawn', prev.note);
    }
    const draft: ChangeDraft = {
      id: randomUUID(),
      agentId,
      status: 'pending',
      origin: input.origin,
      patch: input.patch,
      reason: input.reason,
      baseVersion: input.baseVersion,
      baseSpecHash: input.baseSpecHash,
      autoReview: null,
      classes: null,
      note: null,
      createdAt: now,
      updatedAt: now,
      respondedAt: null,
    };
    await writeJsonAtomic(this.currentPath(agentId), draft);
    this.notifyDraftWritten(agentId, draft);
    return { draft, replaced };
  }

  /**
   * Restates the pending draft's `patch`/`reason` in place (same draft
   * id). A content change also clears `autoReview` - the old verdict
   * binds to the old fingerprint - and notifies `onDraftWritten`
   * listeners; a no-op update writes nothing and notifies nobody.
   * Throws {@link NoDraftError}/{@link DraftMismatchError} like `settle`.
   */
  async update(agentId: string, draftId: string, changes: DraftUpdate): Promise<ChangeDraft> {
    const cur = await this.current(agentId);
    if (cur === undefined) throw new NoDraftError(agentId);
    if (draftId !== cur.id) throw new DraftMismatchError(agentId, draftId);
    const patch = changes.patch ?? cur.patch;
    const reason = changes.reason ?? cur.reason;
    const contentChanged =
      stableStringify(patch) !== stableStringify(cur.patch) || reason !== cur.reason;
    if (!contentChanged) return cur;
    const updated: ChangeDraft = {
      ...cur,
      patch,
      reason,
      autoReview: null,
      updatedAt: this.clock().toISOString(),
    };
    await writeJsonAtomic(this.currentPath(agentId), updated);
    this.notifyDraftWritten(agentId, updated);
    return updated;
  }

  /**
   * Stamps the routine/gated `classes` and clears `autoReview` ahead of
   * the review pass (L11a). `fingerprint` must still match the current
   * draft's `{patch, reason, baseVersion}` - a restated draft keeps its
   * own listener run to classify it. Review bookkeeping never notifies
   * `onDraftWritten` - that listener is what got us here. Returns the
   * updated draft, or `undefined` when `draftId` is no longer pending
   * or the fingerprint went stale.
   */
  async setReviewInput(
    agentId: string,
    draftId: string,
    classes: DraftFieldClasses,
    fingerprint: string
  ): Promise<ChangeDraft | undefined> {
    const cur = await this.current(agentId);
    if (cur === undefined || cur.id !== draftId || cur.status !== 'pending') return undefined;
    if (draftFingerprint(cur) !== fingerprint) return undefined;
    const updated: ChangeDraft = { ...cur, classes, autoReview: null, updatedAt: this.clock().toISOString() };
    await writeJsonAtomic(this.currentPath(agentId), updated);
    return updated;
  }

  /**
   * Writes `autoReview` onto the pending draft, but only while it still
   * is `draftId`, still `pending`, and its `{patch, reason, baseVersion}`
   * fingerprint equals `fingerprint` - a restated or settled draft drops
   * the late verdict. Returns whether the write landed.
   */
  async setAutoReview(agentId: string, draftId: string, review: ChangeDraft['autoReview'], fingerprint: string): Promise<boolean> {
    const cur = await this.current(agentId);
    if (cur === undefined || cur.id !== draftId || cur.status !== 'pending') return false;
    if (draftFingerprint(cur) !== fingerprint) return false;
    const updated: ChangeDraft = { ...cur, autoReview: review, updatedAt: this.clock().toISOString() };
    await writeJsonAtomic(this.currentPath(agentId), updated);
    return true;
  }

  /**
   * Subscribes `listener` to draft writes that created the draft or
   * changed its patch/reason (the auto-review pass's hook, L11a); the
   * returned function unsubscribes. Listener errors are caught and
   * logged - a bad listener must never fail the write that succeeded.
   */
  onDraftWritten(listener: DraftWrittenListener): () => void {
    this.writtenListeners.add(listener);
    return () => {
      this.writtenListeners.delete(listener);
    };
  }

  /** Fans `draft` out to the `onDraftWritten` listeners; each runs behind its own try/catch. */
  private notifyDraftWritten(agentId: string, draft: ChangeDraft): void {
    for (const listener of this.writtenListeners) {
      try {
        listener(agentId, draft);
      } catch (error) {
        console.warn(`[agent-forge] draft-written listener failed for '${agentId}' draft ${draft.id}:`, error);
      }
    }
  }

  /**
   * Moves the current pending draft to history with `status` and removes
   * `current.json`. `opts.draftId`, when given, must be the current
   * draft's id - a different one throws {@link DraftMismatchError} and
   * changes nothing on disk. Throws {@link NoDraftError} when the agent
   * has no pending draft.
   */
  async settle(
    agentId: string,
    status: Exclude<DraftStatus, 'pending'>,
    opts?: { draftId?: string; note?: string | null }
  ): Promise<ChangeDraft> {
    const cur = await this.current(agentId);
    if (cur === undefined) throw new NoDraftError(agentId);
    if (opts?.draftId !== undefined && opts.draftId !== cur.id) {
      throw new DraftMismatchError(agentId, opts.draftId);
    }
    const settled = await this.settleToHistory(agentId, cur, status, opts?.note ?? null);
    await fsPromises.rm(this.currentPath(agentId), { force: true });
    return settled;
  }

  /**
   * Every settled draft, newest `respondedAt` first. A history file that
   * no longer parses is warned about and skipped rather than failing the
   * whole history.
   */
  async history(agentId: string): Promise<ChangeDraft[]> {
    let files: string[];
    try {
      files = await fsPromises.readdir(this.historyDir(agentId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const drafts: ChangeDraft[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(this.historyDir(agentId), file);
      try {
        drafts.push(JSON.parse(await fsPromises.readFile(filePath, 'utf8')) as ChangeDraft);
      } catch {
        console.warn(`[agent-forge] skipping unparsable draft history file ${filePath}`);
      }
    }
    drafts.sort((a, b) => (b.respondedAt ?? '').localeCompare(a.respondedAt ?? ''));
    return drafts;
  }
}

/**
 * The `{ spec, labels }` `patch` would produce over `base`: an omitted
 * key keeps `base`'s value, `null` deletes the spec key (`labels: null`
 * clears to `[]`), any other value replaces - lists wholesale. A
 * `version` key is ignored when present. Pure: `base` is cloned before
 * anything is touched, and no validation runs here - callers run
 * `agentSpecV2Schema` on the result.
 */
export function applySpecPatch(base: SpecSnapshot, patch: SpecPatch): SpecSnapshot {
  const spec = structuredClone(base.spec) as unknown as Record<string, unknown>;
  let labels = [...base.labels];
  for (const key of Object.keys(patch)) {
    if (key === 'version') continue;
    if (key === 'labels') {
      labels = patch.labels == null ? [] : [...patch.labels];
      continue;
    }
    const value = (patch as Record<string, unknown>)[key];
    if (value === null) {
      delete spec[key];
    } else {
      spec[key] = value;
    }
  }
  return { spec: spec as unknown as AgentSpecV2, labels };
}
