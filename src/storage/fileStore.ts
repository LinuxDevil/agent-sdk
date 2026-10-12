/**
 * `fileStore(dir)` (R2): an `AgentStore` of plain JSON files, for a Node
 * process that should keep sessions, checkpoints and paused approvals across
 * restarts without a database:
 *
 *   `<dir>/sessions/<id>.json`             a transcript (`FileSessionStore`)
 *   `<dir>/checkpoints/<id>.json`          the latest checkpoint of a run
 *   `<dir>/checkpoint-history/<id>.json`   its bounded history, oldest first
 *   `<dir>/approvals/<id>.json`            a pending approval and its snapshot
 *   `<dir>/leases/<id>.json`               the run lease of a checkpointed run while it executes
 *   `<dir>/oauth/tokens/<sha256>.json`     an OAuth token or client, encrypted (`{ key, payload }`)
 *   `<dir>/oauth/pending/<state>.json`     a pending sign-in, encrypted (`{ expiresAt, payload }`)
 *
 * Ids are written case-safe (`Alice` -> `^alice`, see `fileNames.ts`), so ids
 * that differ only in case never share a file on Windows or macOS; files
 * written before that encoding are still read. An id too long for a file name
 * once case-safe, or a Windows device name, is stored under `~<prefix>~<hash>`
 * (see `atomicFile.ts`).
 *
 * Every write goes to a temp file, is flushed to disk and renamed into place,
 * so neither a crash nor a power loss leaves half a file. Lock files guard only
 * the compare-and-swaps (a session's `saveIf`, a run lease), and a lock left by
 * a crashed writer is taken over. Two processes saving one session's checkpoint
 * at the same time can lose one history entry (the ring is a read-modify-write),
 * but the run lease keeps two processes from running one checkpointed run at
 * once; resolving an approval is safe across processes (see `FileApprovalStore`).
 */

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { approvalExpired, oldestFirst, type ApprovalStore, type ExecutionSnapshot, type PendingApproval, type ResolvedApproval } from '../execution/ApprovalGate';
import {
  appendToRing,
  HAS_CHECKPOINT_HISTORY,
  pausedApprovalIds,
  listCheckpoints,
  listedCheckpoint,
  parseCheckpoint,
  newestFirst,
  resolveHistoryLimit,
  toHistoryEntry,
  type Checkpoint,
  type CheckpointDeleteOptions,
  type CheckpointHistoryEntry,
  type CheckpointHistoryOptions,
  type CheckpointListEntry,
  type CheckpointListOptions,
  type CheckpointStore,
} from '../execution/checkpoint';
import { ConfigurationError, SDKError } from '../execution/errors';
import { decodeBytes, encodeBytes, FileSessionStore } from '../session/sessionStore';
import type { AgentStore } from './agentStore';
import { caseSafeName, findLegacyFile, idFromCaseSafeName, removeLegacyFile } from './fileNames';
import { fileNameOf, HASHED_NAME_MARK, legacyNamesOf, readTextFile, stageFileAtomic, TEMP_FILE_SUFFIX, writeFileAtomic } from './atomicFile';
import { withFileLock } from './fileLock';
import { LEASE_SWEEP_AGE_MS, leaseAvailable, newLeaseRecord, parseLeaseRecord } from './leaseRecord';
import { assertCheckpointId, isCheckpointId } from '../session/checkpointId';
import { SealedTokenStore, type SealedRecordBackend } from '../oauth/sealedTokenStore';
import type { TokenKeyInput } from '../oauth/tokenCipher';

/** Options of {@link fileStore}. */
export interface FileStoreOptions {
  /** Checkpoints kept per session in `checkpoints.history()` (default 50, `0` keeps none). */
  historyLimit?: number;
  /**
   * Key of the OAuth tokens in `store.tokens`: 32 random bytes as base64
   * (`generateTokenKey()`), or several, newest first, to read tokens written
   * under an older key. Default: the `LOUSHO_TOKEN_KEY` environment variable.
   */
  tokenKey?: TokenKeyInput;
}

/** Approval ids arrive from HTTP input and become file names. */
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function assertId(id: string, pattern: RegExp, what: string): void {
  if (typeof id !== 'string' || !pattern.test(id)) {
    throw new ConfigurationError(`Invalid ${what} ${JSON.stringify(id)}: it becomes a file name, so use letters, digits, '_' and '-'.`, 'id');
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

const readText = readTextFile;

/** Read `<id>.json` in `dir` under its file name, or under its legacy name (the id itself) when only that exists. */
async function readById(dir: string, id: string): Promise<string | undefined> {
  const raw = await readText(join(dir, `${fileNameOf(id)}.json`));
  if (raw !== undefined) return raw;
  const legacy = await findLegacyFile(dir, fileNameOf(id), legacyNamesOf(id));
  return legacy === undefined ? undefined : readText(legacy);
}

/** Write `value` as JSON to `file`, atomically and durably (see `writeFileAtomic`). */
async function writeAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, encodeBytes));
}

/**
 * Claim `file` with an exclusive create of `<file>.claim` (atomic on POSIX and
 * NTFS), read it, delete it and release the claim: of two callers, in one
 * process or two, exactly one gets the content. `undefined` when another
 * caller holds the claim or there is no file. A claim older than
 * `staleClaimMs` whose file is still there was left by a caller that crashed
 * before deleting it: it is taken over (by one caller only, see `withFileLock`).
 */
async function takeFile(file: string, staleClaimMs = STALE_CLAIM_MS): Promise<string | undefined> {
  const claim = `${file}.claim`;
  try {
    await writeFile(claim, String(process.pid), { flag: 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined; // nothing was ever saved
    if (code !== 'EEXIST') throw error;
    return takeOverStaleClaim(file, claim, staleClaimMs);
  }
  try {
    const raw = await readText(file);
    if (raw !== undefined) await rm(file, { force: true });
    return raw;
  } finally {
    await rm(claim, { force: true });
  }
}

/** How old a `.claim` file must be (ms) to count as left by a crashed resolver. */
const STALE_CLAIM_MS = 60_000;

/** {@link takeFile} when a claim file is there: `undefined` unless it is stale and this caller takes it over. */
async function takeOverStaleClaim(file: string, claim: string, staleClaimMs: number): Promise<string | undefined> {
  const age = await stat(claim).then(
    (held) => Date.now() - held.mtimeMs,
    () => undefined
  );
  if (age === undefined || age <= staleClaimMs) return undefined;
  // One caller at a time decides on the stale claim; it reads the file under the lock and deletes it with the claim.
  return withFileLock(
    `${file}.reclaim`,
    async () => {
      const still = await stat(claim).then(
        (held) => Date.now() - held.mtimeMs > staleClaimMs,
        () => false
      );
      if (!still) return undefined;
      const raw = await readText(file);
      if (raw !== undefined) await rm(file, { force: true });
      await rm(claim, { force: true });
      return raw;
    },
    { timeoutMs: 1_000, staleMs: staleClaimMs }
  ).catch(() => undefined);
}

/** Field holding the id in a checkpoint file whose name is shortened (`fileNameOf`), so `list()` can name it. */
const ID_FIELD = '$checkpointId';

/** Checkpoints and their history as JSON files; created on first write. Run leases live in `leaseDir`. */
class FileCheckpointStore implements CheckpointStore {
  private readonly historyLimit: number;
  private lastSweep = 0;

  constructor(
    private readonly checkpointDir: string,
    private readonly historyDir: string,
    private readonly leaseDir: string,
    options: FileStoreOptions
  ) {
    this.historyLimit = resolveHistoryLimit(options.historyLimit);
  }

  private fileFor(dir: string, sessionId: string): string {
    assertCheckpointId(sessionId);
    return join(dir, `${fileNameOf(sessionId)}.json`);
  }

  /** The oldest-first ring; a missing or unreadable (half-written) file counts as empty. */
  private async readRing(sessionId: string): Promise<CheckpointHistoryEntry[]> {
    assertCheckpointId(sessionId);
    const raw = await readById(this.historyDir, sessionId);
    if (raw === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(raw, decodeBytes);
      return Array.isArray(parsed) ? (parsed as CheckpointHistoryEntry[]) : [];
    } catch {
      return [];
    }
  }

  async save(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    await this.write(sessionId, checkpoint);
  }

  /**
   * Writes the checkpoint and its history ring to temp files, then renames each
   * into place only while `fence()` holds (a fenced save: the lease is still the
   * writer's); `false` when it no longer did and nothing was put in place.
   */
  private async write(sessionId: string, checkpoint: Checkpoint, fence?: () => Promise<boolean>): Promise<boolean> {
    const file = this.fileFor(this.checkpointDir, sessionId);
    const name = fileNameOf(sessionId);
    const staged = [await stageFileAtomic(file, JSON.stringify(name.includes(HASHED_NAME_MARK) ? { ...checkpoint, [ID_FIELD]: sessionId } : checkpoint, encodeBytes))];
    try {
      if (this.historyLimit > 0) {
        const ring = appendToRing(await this.readRing(sessionId), toHistoryEntry(checkpoint), this.historyLimit);
        staged.push(await stageFileAtomic(this.fileFor(this.historyDir, sessionId), JSON.stringify(ring, encodeBytes)));
      }
      while (staged.length > 0) {
        if (fence && !(await fence())) return false;
        await staged[0].commit();
        staged.shift();
      }
    } finally {
      for (const left of staged) await left.discard();
    }
    await removeLegacyFile(this.checkpointDir, name, legacyNamesOf(sessionId));
    if (this.historyLimit > 0) await removeLegacyFile(this.historyDir, name, legacyNamesOf(sessionId));
    return true;
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    assertCheckpointId(sessionId);
    const raw = await readById(this.checkpointDir, sessionId);
    if (raw === undefined) return null;
    const checkpoint = parseCheckpoint(raw, sessionId, `${this.checkpointDir}/${fileNameOf(sessionId)}.json`, decodeBytes);
    delete (checkpoint as Checkpoint & { [ID_FIELD]?: string })[ID_FIELD];
    return checkpoint;
  }

  async delete(sessionId: string, options: CheckpointDeleteOptions = {}): Promise<void> {
    const name = fileNameOf(sessionId);
    await rm(this.fileFor(this.checkpointDir, sessionId), { force: true });
    await removeLegacyFile(this.checkpointDir, name, legacyNamesOf(sessionId));
    if (options.keepHistory) return;
    await rm(this.fileFor(this.historyDir, sessionId), { force: true });
    await removeLegacyFile(this.historyDir, name, legacyNamesOf(sessionId));
  }

  async history(sessionId: string, options?: CheckpointHistoryOptions): Promise<CheckpointHistoryEntry[]> {
    return newestFirst(await this.readRing(sessionId), options);
  }

  /** Whether `sessionId` has a history file, without reading it. */
  async [HAS_CHECKPOINT_HISTORY](sessionId: string): Promise<boolean> {
    const found = await stat(this.fileFor(this.historyDir, sessionId)).then(
      () => true,
      () => false
    );
    return found || (await findLegacyFile(this.historyDir, fileNameOf(sessionId), legacyNamesOf(sessionId))) !== undefined;
  }

  /**
   * Eve DUR-F15: the latest checkpoint of every id in the directory, by id. A
   * file that cannot be read as a checkpoint is listed as an `'in-progress'` run
   * whose `lastError` is `LOUSHO_CHECKPOINT_CORRUPT`, as `load()` reports it.
   */
  async list(options?: CheckpointListOptions): Promise<CheckpointListEntry[]> {
    const files = new Map<string, string>();
    const shortened: string[] = [];
    for (const name of await jsonFiles(this.checkpointDir)) {
      if (name.includes(HASHED_NAME_MARK)) {
        shortened.push(name);
        continue;
      }
      const id = idFromCaseSafeName(name);
      if (!isCheckpointId(id)) continue;
      // A legacy file (named by the id itself) counts only when its case-safe file is missing.
      if (name === caseSafeName(id) || !files.has(id)) files.set(id, name);
    }
    const found: Array<readonly [string, Checkpoint]> = [];
    for (const [id, name] of files) {
      const raw = await readText(join(this.checkpointDir, `${name}.json`));
      if (raw !== undefined) found.push(listedCheckpoint(id, () => parseCheckpoint(raw, id, `${this.checkpointDir}/${name}.json`, decodeBytes)));
    }
    for (const name of shortened) {
      const entry = await this.readShortened(name);
      if (entry) found.push(entry);
    }
    return listCheckpoints(found, options);
  }

  /** A checkpoint under a shortened name, with the id it holds; `undefined` when it cannot be read (nor named). */
  private async readShortened(name: string): Promise<[string, Checkpoint] | undefined> {
    const raw = await readText(join(this.checkpointDir, `${name}.json`));
    const parsed = raw === undefined ? undefined : parseJson<Checkpoint & { [ID_FIELD]?: unknown }>(raw, decodeBytes);
    const id = parsed?.[ID_FIELD];
    if (typeof id !== 'string' || !Array.isArray(parsed?.messages)) return undefined;
    delete parsed[ID_FIELD];
    return [id, parsed];
  }

  private leaseFile(sessionId: string): string {
    return this.fileFor(this.leaseDir, sessionId);
  }

  /** Run lease: a compare-and-swap of `leases/<id>.json` under its lock file. */
  async acquireLease(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    const file = this.leaseFile(sessionId);
    await mkdir(this.leaseDir, { recursive: true });
    await this.sweepLeases();
    return withFileLock(`${file}.lock`, async () => {
      if (!leaseAvailable(parseLeaseRecord(await readText(file)), owner)) return false;
      await writeAtomic(file, newLeaseRecord(owner, ttlMs));
      return true;
    });
  }

  /** Renews `owner`'s own lease under its lock file; a lease that is gone or another owner's is not taken. */
  async renewLease(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    return this.underOwnLease(sessionId, owner, async (file, owned) => {
      const staged = await stageFileAtomic(file, JSON.stringify(newLeaseRecord(owner, ttlMs)));
      if (!(await owned())) {
        await staged.discard();
        return false;
      }
      await staged.commit();
      return true;
    });
  }

  /** Saves under the lease's lock file, only while `owner` holds the lease (checked again right before each file goes in place). */
  async saveIfLeased(sessionId: string, checkpoint: Checkpoint, owner: string): Promise<boolean> {
    return this.underOwnLease(sessionId, owner, (_file, owned) => this.write(sessionId, checkpoint, owned));
  }

  /**
   * Runs `task` under the lease's lock when `owner` holds the lease on `sessionId`; `false` (nothing run) otherwise.
   * `owned()` checks again that the lock is still this caller's and the lease `owner`'s: a writer that stalled
   * (a suspended process) past the lock's staleness can find another process took both over meanwhile.
   */
  private async underOwnLease(sessionId: string, owner: string, task: (file: string, owned: () => Promise<boolean>) => Promise<boolean>): Promise<boolean> {
    const file = this.leaseFile(sessionId);
    if ((await readText(file)) === undefined) return false;
    return withFileLock(`${file}.lock`, async (held) => {
      const owned = async () => (await held()) && parseLeaseRecord(await readText(file))?.owner === owner;
      if (!(await owned())) return false;
      return task(file, owned);
    });
  }

  async releaseLease(sessionId: string, owner: string): Promise<void> {
    await this.underOwnLease(sessionId, owner, async (file, owned) => {
      if (await owned()) await rm(file, { force: true });
      return true;
    });
  }

  /** Removes leases (and one-off claims) that expired long ago, at most once a minute. */
  private async sweepLeases(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const name of await jsonFiles(this.leaseDir)) {
      const file = join(this.leaseDir, `${name}.json`);
      const record = parseLeaseRecord(await readText(file));
      if (record && record.expiresAt < now - LEASE_SWEEP_AGE_MS) await rm(file, { force: true });
    }
  }
}

/**
 * One JSON file per pending approval. `resolve` first creates `<id>.json.claim`
 * with an exclusive create (`wx`, atomic on POSIX and NTFS), so of two callers
 * resolving one approval, in one process or two, exactly one gets the record.
 * (A rename is not a safe claim on Windows: two renames of one file can both
 * succeed.) A resolver that crashes after claiming leaves the claim file, and
 * the approval then resolves to `null`; saving it again clears the claim.
 */
class FileApprovalStore implements ApprovalStore {
  constructor(private readonly dir: string) {}

  private fileFor(id: string): string {
    assertId(id, APPROVAL_ID_PATTERN, 'approval id');
    return join(this.dir, `${fileNameOf(id)}.json`);
  }

  /** The file of `id` written before case-safe names, when there is one. */
  private legacyFile(id: string): Promise<string | undefined> {
    return findLegacyFile(this.dir, fileNameOf(id), legacyNamesOf(id));
  }

  async save(pending: PendingApproval, snapshot: ExecutionSnapshot): Promise<void> {
    const file = this.fileFor(pending.id);
    const record: ResolvedApproval = { pending, snapshot };
    await writeAtomic(file, record);
    await rm(`${file}.claim`, { force: true });
    await removeLegacyFile(this.dir, fileNameOf(pending.id), legacyNamesOf(pending.id));
  }

  async resolve(id: string): Promise<ResolvedApproval | null> {
    let raw = await takeFile(this.fileFor(id));
    if (raw === undefined) {
      const legacy = await this.legacyFile(id);
      if (legacy !== undefined) raw = await takeFile(legacy);
    }
    return raw === undefined ? null : (JSON.parse(raw, decodeBytes) as ResolvedApproval);
  }

  /**
   * A record a resolver already claimed (its `.claim` file was left by a crash) reads as resolved, like `resolve` sees it.
   * An id that could not name a file is not found: only writes reject it.
   */
  async load(id: string): Promise<ResolvedApproval | null> {
    if (typeof id !== 'string' || !APPROVAL_ID_PATTERN.test(id)) return null;
    let file = this.fileFor(id);
    if ((await readText(file)) === undefined) file = (await this.legacyFile(id)) ?? file;
    const [raw, claim] = await Promise.all([readText(file), readText(`${file}.claim`)]);
    return raw === undefined || claim !== undefined ? null : (JSON.parse(raw, decodeBytes) as ResolvedApproval);
  }

  /** Eve TOOLS-F13: every unclaimed record in the directory, oldest first; a half-written file is skipped. */
  async list(): Promise<PendingApproval[]> {
    const found = new Map<string, PendingApproval>();
    for (const name of await jsonFiles(this.dir)) {
      const file = join(this.dir, `${name}.json`);
      const [raw, claim] = await Promise.all([readText(file), readText(`${file}.claim`)]);
      if (raw === undefined || claim !== undefined) continue;
      let pending: PendingApproval | undefined;
      try {
        pending = (JSON.parse(raw, decodeBytes) as ResolvedApproval | null)?.pending;
      } catch {
        continue; // half-written
      }
      if (pending && typeof pending.id === 'string' && !found.has(pending.id)) found.set(pending.id, pending);
    }
    return oldestFirst([...found.values()]);
  }
}

/** The JSON files' names in `dir`, without `.json`; `[]` when `dir` does not exist. */
async function jsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** `undefined` for text that is not JSON (a half-written file). */
function parseJson<T>(raw: string, reviver?: (key: string, value: unknown) => unknown): T | undefined {
  try {
    return JSON.parse(raw, reviver) as T;
  } catch {
    return undefined;
  }
}

/** Parse a JSON file written by this store; `undefined` when it is missing or half-written. */
async function readJson<T>(file: string): Promise<T | undefined> {
  const raw = await readText(file);
  return raw === undefined ? undefined : parseJson<T>(raw);
}

/**
 * Sealed OAuth records as files (`SealedTokenStore` encrypts them). Token
 * files are named by the SHA-256 of their key (a key holds characters a file
 * name cannot, and can be long); pending sign-ins by their validated state.
 * Taking a pending sign-in claims it like `FileApprovalStore.resolve`.
 */
class FileTokenBackend implements SealedRecordBackend {
  constructor(
    private readonly tokensDir: string,
    private readonly pendingDir: string
  ) {}

  private tokenFile(key: string): string {
    return join(this.tokensDir, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  async get(key: string): Promise<string | undefined> {
    const record = await readJson<{ key: string; payload: string }>(this.tokenFile(key));
    return record?.key === key ? record.payload : undefined;
  }

  async put(key: string, sealed: string): Promise<void> {
    await writeAtomic(this.tokenFile(key), { key, payload: sealed });
  }

  async delete(key: string): Promise<void> {
    await rm(this.tokenFile(key), { force: true });
  }

  async list(prefix: string): Promise<Array<{ key: string; sealed: string }>> {
    const rows: Array<{ key: string; sealed: string }> = [];
    for (const name of await jsonFiles(this.tokensDir)) {
      const record = await readJson<{ key: unknown; payload: unknown }>(join(this.tokensDir, `${name}.json`));
      if (typeof record?.key === 'string' && typeof record.payload === 'string' && record.key.startsWith(prefix)) {
        rows.push({ key: record.key, sealed: record.payload });
      }
    }
    return rows;
  }

  async putPending(state: string, sealed: string, expiresAt: number): Promise<void> {
    await this.removeExpiredPending();
    const file = join(this.pendingDir, `${state}.json`);
    await writeAtomic(file, { expiresAt, payload: sealed });
    await rm(`${file}.claim`, { force: true });
  }

  /** Sign-ins nobody completed would otherwise stay forever: drop the expired ones on each new one. Returns how many. */
  async removeExpiredPending(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const name of await jsonFiles(this.pendingDir)) {
      const file = join(this.pendingDir, `${name}.json`);
      const record = await readJson<{ expiresAt?: unknown }>(file);
      if (typeof record?.expiresAt === 'number' && record.expiresAt <= now) {
        await rm(file, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  async takePending(state: string): Promise<string | undefined> {
    const raw = await takeFile(join(this.pendingDir, `${state}.json`));
    const payload = raw === undefined ? undefined : parseJson<{ payload?: unknown }>(raw)?.payload;
    return typeof payload === 'string' ? payload : undefined;
  }
}

/** Options of {@link FileStore.prune}. */
export interface FileStorePruneOptions {
  /** Delete files last written more than this many milliseconds ago. */
  olderThanMs: number;
  /**
   * Also delete pending approvals whose `approvalTtlMs` deadline (`expiresAt`)
   * has passed: deciding them could only deny them. Their runs are then no
   * longer kept as paused, so an old one goes like any other old run. Default `false`.
   */
  expiredApprovals?: boolean;
}

/** How many files {@link FileStore.prune} deleted, per kind. */
export interface FileStorePruneResult {
  /** Transcripts. */
  sessions: number;
  /** Latest checkpoints. */
  checkpoints: number;
  /** Checkpoint history files (of the deleted checkpoints, and old turn history a session no longer keeps). */
  checkpointHistory: number;
  /** Expired pending OAuth sign-ins (deleted whatever `olderThanMs` is). */
  oauthPending: number;
  /** Pending approvals past their deadline (only with `expiredApprovals: true`). */
  approvals: number;
  /** Temp files left by a writer that was killed mid-write (older than `olderThanMs` and a minute). */
  tempFiles: number;
}

/** The store {@link fileStore} returns: an {@link AgentStore} with every part, and `prune()`. */
export type FileStore = Required<AgentStore> & {
  /**
   * Deletes transcripts, checkpoints and checkpoint history files last written
   * more than `olderThanMs` ago, and expired pending OAuth sign-ins, like
   * `SqliteStore.prune()`. Pending approvals and OAuth tokens are kept, and so
   * is a run paused on a pending approval, however old: its checkpoint (and
   * history) and its session's transcript. A run that is running now (its run
   * lease is live) or whose checkpoint was written after the cutoff is kept
   * with its session's transcript too. Old turn history a session no longer
   * keeps (an earlier release kept every turn's) goes too, and so do temp files
   * a killed writer left. `expiredApprovals: true` also deletes pending
   * approvals past their deadline.
   */
  prune(options: FileStorePruneOptions): Promise<FileStorePruneResult>;
};

/** A session turn's checkpoint id, `<session id>.turn-<n>`, or its paused-turn pointer `<session id>.paused`. */
const SESSION_KEY = /^(.+)\.(?:turn-\d+|paused)$/;

/** The file names (without `.json`) `ids` are or were stored under. */
function namesOf(ids: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const id of ids) for (const name of [fileNameOf(id), ...legacyNamesOf(id)]) names.add(name);
  return names;
}

/** Deletes the `.json` files in `dir` last written before `cutoff` whose name is not in `keep`; returns how many. */
async function removeStale(dir: string, cutoff: number, keep: Set<string>): Promise<number> {
  let removed = 0;
  for (const name of await jsonFiles(dir)) {
    if (keep.has(name)) continue;
    const file = join(dir, `${name}.json`);
    const written = await stat(file).then(
      (found) => found.mtimeMs,
      () => undefined
    );
    if (written === undefined || written >= cutoff) continue;
    await rm(file, { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * The ids a paused run needs (see {@link FileStore.prune}): the run each
 * pending approval's snapshot names, every checkpoint that waits on a pending
 * approval, and the sessions of those that are session turns.
 */
async function pausedRuns(root: string): Promise<{ runs: Set<string>; sessions: Set<string> }> {
  const approvals = new Set<string>();
  const runs = new Set<string>();
  const approvalDir = join(root, 'approvals');
  for (const name of await jsonFiles(approvalDir)) {
    const record = await readJson<Partial<ResolvedApproval>>(join(approvalDir, `${name}.json`));
    if (typeof record?.pending?.id === 'string') approvals.add(record.pending.id);
    const run = record?.snapshot?.sessionId;
    if (typeof run === 'string' && run !== '') runs.add(run);
  }
  const checkpointDir = join(root, 'checkpoints');
  for (const name of await jsonFiles(checkpointDir)) {
    const checkpoint = await readJson<Partial<Checkpoint> & { [ID_FIELD]?: unknown }>(join(checkpointDir, `${name}.json`));
    if (!checkpoint || !pausedApprovalIds(checkpoint).some((id) => approvals.has(id))) continue;
    const id = name.includes(HASHED_NAME_MARK) ? checkpoint[ID_FIELD] : idFromCaseSafeName(name);
    if (typeof id === 'string') runs.add(id);
  }
  const sessions = new Set([...runs].map((run) => SESSION_KEY.exec(run)?.[1] ?? run));
  return { runs, sessions };
}

/** The id a checkpoint or lease file named `name` (no `.json`) in `root` is for; `undefined` when it cannot be told. */
async function idOfName(root: string, name: string): Promise<string | undefined> {
  if (!name.includes(HASHED_NAME_MARK)) return idFromCaseSafeName(name);
  const id = (await readJson<{ [ID_FIELD]?: unknown }>(join(root, 'checkpoints', `${name}.json`)))?.[ID_FIELD];
  return typeof id === 'string' ? id : undefined;
}

/**
 * The runs {@link FileStore.prune} keeps because they may be running: a live
 * run lease, or a checkpoint written at or after `cutoff` (a session turn's
 * keeps its session's transcript, however old that is).
 */
async function activeRuns(root: string, cutoff: number): Promise<{ names: Set<string>; sessions: Set<string> }> {
  const names = new Set<string>();
  const leaseDir = join(root, 'leases');
  for (const name of await jsonFiles(leaseDir)) {
    const record = parseLeaseRecord(await readText(join(leaseDir, `${name}.json`)));
    if (record && !leaseAvailable(record, '')) names.add(name);
  }
  const checkpointDir = join(root, 'checkpoints');
  for (const name of await jsonFiles(checkpointDir)) {
    const written = await stat(join(checkpointDir, `${name}.json`)).then(
      (found) => found.mtimeMs,
      () => undefined
    );
    if (written !== undefined && written >= cutoff) names.add(name);
  }
  const sessions = new Set<string>();
  for (const name of names) {
    const id = await idOfName(root, name);
    if (id !== undefined) sessions.add(SESSION_KEY.exec(id)?.[1] ?? id);
  }
  return { names, sessions };
}

/** Deletes the pending approvals in `dir` whose deadline passed; returns how many. */
async function removeExpiredApprovals(dir: string): Promise<number> {
  let removed = 0;
  for (const name of await jsonFiles(dir)) {
    const file = join(dir, `${name}.json`);
    const pending = (await readJson<Partial<ResolvedApproval>>(file))?.pending;
    if (!pending || !approvalExpired(pending)) continue;
    await rm(file, { force: true });
    removed += 1;
  }
  return removed;
}

/** A temp file younger than this is left alone by prune: its writer may still be about to rename it. */
const TEMP_FILE_MIN_AGE_MS = 60_000;

/** Deletes the temp files of `writeFileAtomic` under `dir` (one level of subdirectories deep) last written before `cutoff`. */
async function removeTempFiles(dir: string, cutoff: number, depth = 2): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) removed += await removeTempFiles(path, cutoff, depth - 1);
      continue;
    }
    if (!TEMP_FILE_SUFFIX.test(entry.name)) continue;
    const written = await stat(path).then(
      (found) => found.mtimeMs,
      () => undefined
    );
    if (written === undefined || written >= cutoff) continue;
    await rm(path, { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * An {@link AgentStore} of plain, inspectable JSON files under `dir`
 * (`sessions/`, `checkpoints/`, `checkpoint-history/`, `approvals/`, and
 * `oauth/` with the OAuth tokens encrypted under `tokenKey`), for
 * `createAgent({ store })` in a Node process. Directories are created on
 * first write.
 *
 * @example
 * ```ts
 * const agent = createAgent({ provider, store: fileStore('./.lousho') });
 * await agent.session({ id: 'user-42' }).send('Hello');
 * ```
 */
export function fileStore(dir: string, options: FileStoreOptions = {}): FileStore {
  const root = resolve(dir);
  const tokenBackend = new FileTokenBackend(join(root, 'oauth', 'tokens'), join(root, 'oauth', 'pending'));
  return {
    sessions: new FileSessionStore(join(root, 'sessions')),
    checkpoints: new FileCheckpointStore(join(root, 'checkpoints'), join(root, 'checkpoint-history'), join(root, 'leases'), options),
    approvals: new FileApprovalStore(join(root, 'approvals')),
    tokens: new SealedTokenStore(tokenBackend, 'fileStore', { tokenKey: options.tokenKey }),
    async prune({ olderThanMs, expiredApprovals = false }) {
      if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
        throw new SDKError(`prune: olderThanMs must be a non-negative number of milliseconds, got ${olderThanMs}.`, 'LOUSHO_CONFIG_INVALID');
      }
      const now = Date.now();
      const cutoff = now - olderThanMs;
      const approvals = expiredApprovals ? await removeExpiredApprovals(join(root, 'approvals')) : 0;
      const paused = await pausedRuns(root);
      const active = await activeRuns(root, cutoff);
      const keepRuns = new Set([...namesOf(paused.runs), ...active.names]);
      const keepSessions = namesOf([...paused.sessions, ...active.sessions]);
      const checkpointHistory = await removeStale(join(root, 'checkpoint-history'), cutoff, keepRuns);
      return {
        sessions: await removeStale(join(root, 'sessions'), cutoff, keepSessions),
        checkpoints: await removeStale(join(root, 'checkpoints'), cutoff, keepRuns),
        checkpointHistory,
        oauthPending: await tokenBackend.removeExpiredPending(),
        approvals,
        tempFiles: await removeTempFiles(root, Math.min(cutoff, now - TEMP_FILE_MIN_AGE_MS)),
      };
    },
  };
}
