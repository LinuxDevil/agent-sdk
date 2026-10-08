/**
 * `fileStore(dir)` (R2): an `AgentStore` of plain JSON files, for a Node
 * process that should keep sessions, checkpoints and paused approvals across
 * restarts without a database:
 *
 *   `<dir>/sessions/<id>.json`             a transcript (`FileSessionStore`)
 *   `<dir>/checkpoints/<id>.json`          the latest checkpoint of a run
 *   `<dir>/checkpoint-history/<id>.json`   its bounded history, oldest first
 *   `<dir>/approvals/<id>.json`            a pending approval and its snapshot
 *   `<dir>/oauth/tokens/<sha256>.json`     an OAuth token or client, encrypted (`{ key, payload }`)
 *   `<dir>/oauth/pending/<state>.json`     a pending sign-in, encrypted (`{ expiresAt, payload }`)
 *
 * Every write goes to a temp file and is renamed into place, so a crash never
 * leaves half a file. No lock files: a crashed writer cannot block anyone.
 * Two processes saving one session's checkpoint at the same time can lose one
 * history entry (the ring is a read-modify-write); resolving an approval is
 * safe across processes (see `FileApprovalStore`).
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval, ResolvedApproval } from '../execution/ApprovalGate';
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
} from '../execution/checkpoint';
import { ConfigurationError } from '../execution/errors';
import { decodeBytes, encodeBytes, FileSessionStore } from '../session/sessionStore';
import type { AgentStore } from './agentStore';
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

/**
 * Checkpoint ids are session ids plus the `.turn-<n>` / `.fork-<n>` suffixes
 * the SDK appends, so a `.` is allowed, but not first (no `.`, `..` or hidden
 * files) and never a path separator.
 */
const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/;

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

/** `undefined` when `file` does not exist. */
async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Write to a unique temp file next to `file` and rename it over `file`; creates the directory when it is missing. */
async function writeAtomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const content = JSON.stringify(value, encodeBytes);
  try {
    try {
      await writeFile(temp, content, 'utf8');
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temp, content, 'utf8');
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Claim `file` with an exclusive create of `<file>.claim` (atomic on POSIX and
 * NTFS), read it, delete it and release the claim: of two callers, in one
 * process or two, exactly one gets the content. `undefined` when another
 * caller holds the claim or there is no file.
 */
async function takeFile(file: string): Promise<string | undefined> {
  const claim = `${file}.claim`;
  try {
    await writeFile(claim, String(process.pid), { flag: 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOENT') return undefined; // another caller has it, or nothing was ever saved
    throw error;
  }
  try {
    const raw = await readText(file);
    if (raw !== undefined) await rm(file, { force: true });
    return raw;
  } finally {
    await rm(claim, { force: true });
  }
}

/** Checkpoints and their history as JSON files; created on first write. */
class FileCheckpointStore implements CheckpointStore {
  private readonly historyLimit: number;

  constructor(
    private readonly checkpointDir: string,
    private readonly historyDir: string,
    options: FileStoreOptions
  ) {
    this.historyLimit = resolveHistoryLimit(options.historyLimit);
  }

  private fileFor(dir: string, sessionId: string): string {
    assertId(sessionId, CHECKPOINT_ID_PATTERN, 'session id');
    return join(dir, `${sessionId}.json`);
  }

  /** The oldest-first ring; a missing or unreadable (half-written) file counts as empty. */
  private async readRing(sessionId: string): Promise<CheckpointHistoryEntry[]> {
    const raw = await readText(this.fileFor(this.historyDir, sessionId));
    if (raw === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(raw, decodeBytes);
      return Array.isArray(parsed) ? (parsed as CheckpointHistoryEntry[]) : [];
    } catch {
      return [];
    }
  }

  async save(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    const file = this.fileFor(this.checkpointDir, sessionId);
    await writeAtomic(file, checkpoint);
    if (this.historyLimit === 0) return;
    const ring = appendToRing(await this.readRing(sessionId), toHistoryEntry(checkpoint), this.historyLimit);
    await writeAtomic(this.fileFor(this.historyDir, sessionId), ring);
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    const raw = await readText(this.fileFor(this.checkpointDir, sessionId));
    return raw === undefined ? null : (JSON.parse(raw, decodeBytes) as Checkpoint);
  }

  async delete(sessionId: string, options: CheckpointDeleteOptions = {}): Promise<void> {
    await rm(this.fileFor(this.checkpointDir, sessionId), { force: true });
    if (!options.keepHistory) await rm(this.fileFor(this.historyDir, sessionId), { force: true });
  }

  async history(sessionId: string, options?: CheckpointHistoryOptions): Promise<CheckpointHistoryEntry[]> {
    return newestFirst(await this.readRing(sessionId), options);
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
    return join(this.dir, `${id}.json`);
  }

  async save(pending: PendingApproval, snapshot: ExecutionSnapshot): Promise<void> {
    const file = this.fileFor(pending.id);
    const record: ResolvedApproval = { pending, snapshot };
    await writeAtomic(file, record);
    await rm(`${file}.claim`, { force: true });
  }

  async resolve(id: string): Promise<ResolvedApproval | null> {
    const raw = await takeFile(this.fileFor(id));
    return raw === undefined ? null : (JSON.parse(raw, decodeBytes) as ResolvedApproval);
  }

  /** A record a resolver already claimed (its `.claim` file was left by a crash) reads as resolved, like `resolve` sees it. */
  async load(id: string): Promise<ResolvedApproval | null> {
    // A malformed id cannot name a saved record: read it as not-found (like a
    // missing id) rather than throwing, so `agent.approvals.get(id)` keeps its
    // documented "`undefined` when `id` is unknown" contract for HTTP input.
    if (typeof id !== 'string' || !APPROVAL_ID_PATTERN.test(id)) return null;
    const file = this.fileFor(id);
    const [raw, claim] = await Promise.all([readText(file), readText(`${file}.claim`)]);
    return raw === undefined || claim !== undefined ? null : (JSON.parse(raw, decodeBytes) as ResolvedApproval);
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
function parseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
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

  /** Sign-ins nobody completed would otherwise stay forever: drop the expired ones on each new one. */
  private async removeExpiredPending(): Promise<void> {
    const now = Date.now();
    for (const name of await jsonFiles(this.pendingDir)) {
      const file = join(this.pendingDir, `${name}.json`);
      const record = await readJson<{ expiresAt?: unknown }>(file);
      if (typeof record?.expiresAt === 'number' && record.expiresAt <= now) await rm(file, { force: true });
    }
  }

  async takePending(state: string): Promise<string | undefined> {
    const raw = await takeFile(join(this.pendingDir, `${state}.json`));
    const payload = raw === undefined ? undefined : parseJson<{ payload?: unknown }>(raw)?.payload;
    return typeof payload === 'string' ? payload : undefined;
  }
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
export function fileStore(dir: string, options: FileStoreOptions = {}): Required<AgentStore> {
  const root = resolve(dir);
  return {
    sessions: new FileSessionStore(join(root, 'sessions')),
    checkpoints: new FileCheckpointStore(join(root, 'checkpoints'), join(root, 'checkpoint-history'), options),
    approvals: new FileApprovalStore(join(root, 'approvals')),
    tokens: new SealedTokenStore(new FileTokenBackend(join(root, 'oauth', 'tokens'), join(root, 'oauth', 'pending')), 'fileStore', {
      tokenKey: options.tokenKey,
    }),
  };
}
