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
import type { AgentSpecV2 } from '@lousho/build-ai-agent';
import type {
  ChangeDraft,
  DraftOrigin,
  DraftStatus,
  SpecPatch,
  SpecSnapshot,
} from '../../shared/wireTypes';
import type { AgentRepo } from './agentRepo';
import { readJsonFile, writeJsonAtomic } from './atomic';

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

/** The draft store over `repo`'s `.lousho/agents/<id>/drafts/` trees. `clock` is injectable for tests. */
export class DraftStore {
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
      note: null,
      createdAt: now,
      updatedAt: now,
      respondedAt: null,
    };
    await writeJsonAtomic(this.currentPath(agentId), draft);
    return { draft, replaced };
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
