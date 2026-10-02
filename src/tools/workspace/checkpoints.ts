/**
 * Workspace rewind (N7): `write_file` and `edit_file` back a file up before
 * they change it, and `WorkspaceCheckpoints.rewind(toTurn)` puts every file
 * the agent changed in that turn or later back the way it was.
 *
 * The API is a separate object rather than a method on the workspace, so it
 * works with any `FsProvider` (including ones users write) and every restore
 * goes through that provider, with its own path confinement.
 */
import { createHash } from 'node:crypto';
import type { ToolExecutionContext } from '../../types/tool';
import type { FsProvider } from './types';
import { normalizeWorkspacePath, WorkspaceError } from './paths';
import { ConfigurationError } from '../../execution/errors';
import { KeyedQueue } from './keyedQueue';

/** One recorded change: the file as it was before a `write_file` / `edit_file` call wrote it. */
export interface WorkspaceFileBackup {
  /** The run's session (`ctx.sessionId`, without a checkpointed turn's `.turn-<n>` suffix), or `'default'`. */
  sessionId: string;
  /** 0-based: the number of user messages in the transcript before the one this call answers. */
  turn: number;
  toolCallId: string;
  /** Workspace-relative, normalized. */
  path: string;
  /** Content before the change; `null` when the file did not exist (or when `omitted` says why it was not kept). */
  before: string | null;
  /** Permission bits before the change, when the provider has `getMode` and the file existed. */
  mode?: number;
  /**
   * Set when the file existed but its content was not kept: `'too-large'`
   * (over `maxFileBytes`; rewind skips the file and never deletes it) or
   * `'same-turn'` (a later write in a turn that already backed the path up;
   * only the turn's first backup is needed to rewind).
   */
  omitted?: 'too-large' | 'same-turn';
  /** sha256 (hex) of what the tool wrote. */
  afterHash: string;
  /** ISO time of the change. */
  at: string;
}

/** Where {@link WorkspaceCheckpoints} keeps backups. The store is the only place file content lives. */
export interface WorkspaceCheckpointStore {
  /** Adds a backup at the end of its session's list. */
  append(backup: WorkspaceFileBackup): Promise<void>;
  /** A session's backups in the order they were appended. */
  list(sessionId: string): Promise<WorkspaceFileBackup[]>;
  /** Drops the backups of turn `turn` and later. `turn <= 0` forgets the session entirely. */
  removeFromTurn(sessionId: string, turn: number): Promise<void>;
  /** Retention: drops the backups of turns before `turn` and remembers that those turns can no longer be rewound. */
  removeBeforeTurn(sessionId: string, turn: number): Promise<void>;
  /** The oldest turn that can still be rewound (the last `removeBeforeTurn` value), 0 when nothing was pruned. */
  earliestTurn(sessionId: string): Promise<number>;
}

/** A session's backups plus how far retention has pruned them. */
export interface WorkspaceCheckpointLog {
  earliestTurn: number;
  backups: WorkspaceFileBackup[];
}

/** {@link WorkspaceCheckpointStore.removeFromTurn} over a log; `undefined` means the session is gone. */
export function logWithoutTurnsFrom(log: WorkspaceCheckpointLog, turn: number): WorkspaceCheckpointLog | undefined {
  if (turn <= 0) return undefined;
  return { earliestTurn: log.earliestTurn, backups: log.backups.filter((b) => b.turn < turn) };
}

/** {@link WorkspaceCheckpointStore.removeBeforeTurn} over a log. */
export function logWithoutTurnsBefore(log: WorkspaceCheckpointLog, turn: number): WorkspaceCheckpointLog {
  return { earliestTurn: Math.max(log.earliestTurn, turn), backups: log.backups.filter((b) => b.turn >= turn) };
}

/**
 * Keeps backups in memory (the default store). They end with the process; use
 * {@link FileWorkspaceCheckpointStore} to rewind after a restart.
 */
export class MemoryWorkspaceCheckpointStore implements WorkspaceCheckpointStore {
  private readonly logs = new Map<string, WorkspaceCheckpointLog>();

  async append(backup: WorkspaceFileBackup): Promise<void> {
    const log = this.logs.get(backup.sessionId) ?? { earliestTurn: 0, backups: [] };
    this.logs.set(backup.sessionId, { ...log, backups: [...log.backups, { ...backup }] });
  }

  async list(sessionId: string): Promise<WorkspaceFileBackup[]> {
    return (this.logs.get(sessionId)?.backups ?? []).map((b) => ({ ...b }));
  }

  async removeFromTurn(sessionId: string, turn: number): Promise<void> {
    const log = this.logs.get(sessionId);
    if (!log) return;
    const next = logWithoutTurnsFrom(log, turn);
    if (next) this.logs.set(sessionId, next);
    else this.logs.delete(sessionId);
  }

  async removeBeforeTurn(sessionId: string, turn: number): Promise<void> {
    this.logs.set(sessionId, logWithoutTurnsBefore(this.logs.get(sessionId) ?? { earliestTurn: 0, backups: [] }, turn));
  }

  async earliestTurn(sessionId: string): Promise<number> {
    return this.logs.get(sessionId)?.earliestTurn ?? 0;
  }
}

/** What {@link WorkspaceCheckpoints.rewind} did (or, with `dryRun`, would do). */
export interface RewindResult {
  dryRun: boolean;
  /** Written back to their earlier content (and mode). */
  restored: string[];
  /** Created by the agent in those turns, so removed. */
  deleted: string[];
  /** Left alone, with the reason. */
  skipped: Array<{ path: string; reason: 'changed-since' | 'too-large' | 'not-a-file' }>;
}

/** Options for {@link WorkspaceCheckpoints}. */
export interface WorkspaceCheckpointsOptions {
  /** Where backups live. Defaults to a {@link MemoryWorkspaceCheckpointStore}. */
  store?: WorkspaceCheckpointStore;
  /** Files larger than this (in UTF-8 bytes) are not backed up; rewind skips them as `'too-large'`. Defaults to 1,000,000. */
  maxFileBytes?: number;
  /**
   * Turns kept per session. When a change is recorded in turn `t`, backups of
   * turns before `t - maxTurns + 1` are dropped and those turns can no longer
   * be rewound. Defaults to 20; `Infinity` keeps every turn.
   */
  maxTurns?: number;
}

/** The session, turn and call a write belongs to, read from the tool's context. */
interface WriteOrigin {
  sessionId: string;
  turn: number;
  toolCallId: string;
}

/** The current state of a path before a write. */
interface Captured {
  before: string | null;
  mode?: number;
  tooLarge: boolean;
}

/** One file's planned rewind. */
type PlannedAction =
  | { kind: 'restore'; path: string; content: string; mode?: number }
  | { kind: 'delete'; path: string }
  | { kind: 'skip'; path: string; reason: RewindResult['skipped'][number]['reason'] };

const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_TURNS = 20;
const TURN_SUFFIX = /\.turn-\d+$/;

/** sha256 (hex) of a UTF-8 string. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** The session id rewind groups by: a checkpointed session turn runs as `<id>.turn-<n>`, which belongs to `<id>`. */
function sessionOf(ctx: ToolExecutionContext | undefined): string {
  const id = ctx?.sessionId;
  return id === undefined || id === '' ? 'default' : id.replace(TURN_SUFFIX, '');
}

/** 0-based index of the user message the call belongs to. */
function turnOf(ctx: ToolExecutionContext | undefined): number {
  const users = (ctx?.messages ?? []).filter((m) => m.role === 'user').length;
  return Math.max(0, users - 1);
}

function originOf(ctx: ToolExecutionContext | undefined): WriteOrigin {
  return { sessionId: sessionOf(ctx), turn: turnOf(ctx), toolCallId: ctx?.toolCallId ?? '' };
}

function assertLimit(value: number | undefined, name: string, allowInfinity: boolean): void {
  if (value === undefined) return;
  const ok = (allowInfinity && value === Infinity) || (Number.isInteger(value) && value > 0);
  if (!ok) throw new ConfigurationError(`WorkspaceCheckpoints: '${name}' must be a positive integer${allowInfinity ? ' or Infinity' : ''}.`, name);
}

/** Orders by turn, keeping append order within a turn. */
function byTurn(backups: readonly WorkspaceFileBackup[]): WorkspaceFileBackup[] {
  return backups.map((b, i) => ({ b, i })).sort((x, y) => x.b.turn - y.b.turn || x.i - y.i).map(({ b }) => b);
}

/** Backups grouped by normalized path; a stored path that is not a valid workspace path throws. */
function groupByPath(backups: readonly WorkspaceFileBackup[]): Map<string, WorkspaceFileBackup[]> {
  const groups = new Map<string, WorkspaceFileBackup[]>();
  for (const backup of backups) {
    let path: string;
    try {
      path = normalizeWorkspacePath(backup.path);
    } catch (error) {
      throw new WorkspaceError(`Refusing to rewind: the checkpoint store holds an invalid path. ${(error as Error).message}`);
    }
    groups.set(path, [...(groups.get(path) ?? []), backup]);
  }
  return groups;
}

/**
 * Records what `write_file` and `edit_file` change and puts it back on
 * request. Pass it to `createFsTools(fs, { checkpoints })`.
 *
 * Changes are grouped by session and by turn (the 0-based index of the user
 * message a tool call answers). `rewind(toTurn)` restores every file changed
 * in turn `toTurn` or later to its content before `toTurn`: a file the agent
 * created is deleted, one it overwrote or edited gets its content (and mode,
 * when the provider has `getMode` / `chmod`) back. The conversation itself is
 * not rewound.
 *
 * @example
 * ```ts
 * import { createAgent, createFsTools, MemoryWorkspace, WorkspaceCheckpoints } from '@lousho/build-ai-agent';
 * import { mockModel } from '@lousho/build-ai-agent/testing';
 * const workspace = new MemoryWorkspace({ files: { 'a.txt': 'one\n' } });
 * const checkpoints = new WorkspaceCheckpoints(workspace);
 * const agent = createAgent({
 *   instructions: 'Edit files.',
 *   provider: mockModel([{ toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'two\n' } }] }, 'Done.']),
 *   tools: createFsTools(workspace, { checkpoints }),
 * });
 * const session = agent.session();
 * await session.send('Change a.txt');
 * await checkpoints.rewind(0, { sessionId: session.id }); // a.txt is 'one\n' again
 * ```
 */
export class WorkspaceCheckpoints {
  private readonly store: WorkspaceCheckpointStore;
  private readonly maxFileBytes: number;
  private readonly maxTurns: number;
  private readonly paths = new KeyedQueue();

  constructor(
    private readonly fs: FsProvider,
    options: WorkspaceCheckpointsOptions = {}
  ) {
    assertLimit(options.maxFileBytes, 'maxFileBytes', false);
    assertLimit(options.maxTurns, 'maxTurns', true);
    this.store = options.store ?? new MemoryWorkspaceCheckpointStore();
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  }

  /**
   * Used by `createFsTools`: captures `path` as it is now, runs `write`
   * (which returns the content it wrote), then records the backup. A write
   * that throws records nothing. Writes to one path are serialized.
   */
  async track(ctx: ToolExecutionContext | undefined, path: string, write: () => Promise<string>): Promise<void> {
    const target = normalizeWorkspacePath(path);
    const origin = originOf(ctx);
    await this.paths.run(target, async () => {
      const captured = await this.capture(target);
      const written = await write();
      await this.record(origin, target, captured, written);
    });
  }

  /** The turns with recorded changes, oldest first, with the paths each changed. */
  async list(options: { sessionId?: string } = {}): Promise<Array<{ turn: number; paths: string[] }>> {
    const turns = new Map<number, Set<string>>();
    for (const backup of await this.store.list(options.sessionId ?? 'default')) {
      turns.set(backup.turn, (turns.get(backup.turn) ?? new Set()).add(backup.path));
    }
    return [...turns.entries()].sort(([a], [b]) => a - b).map(([turn, paths]) => ({ turn, paths: [...paths].sort() }));
  }

  /**
   * Restores every file changed in turn `toTurn` or later to its content
   * before `toTurn`. A file whose content is no longer what the agent last
   * wrote was changed by something else and is skipped as `'changed-since'`
   * unless `force`. `dryRun` changes nothing and returns the same result.
   * A real rewind then forgets the backups of those turns (skipped files'
   * included). Every path is checked (and read) before anything is written.
   */
  async rewind(toTurn: number, options: { sessionId?: string; dryRun?: boolean; force?: boolean } = {}): Promise<RewindResult> {
    if (!Number.isInteger(toTurn) || toTurn < 0) throw new WorkspaceError(`rewind: toTurn must be a non-negative integer, got ${String(toTurn)}.`);
    const sessionId = options.sessionId ?? 'default';
    const dryRun = options.dryRun === true;
    const earliest = await this.store.earliestTurn(sessionId);
    if (toTurn < earliest) {
      throw new WorkspaceError(
        `rewind: turns before ${earliest} of session ${JSON.stringify(sessionId)} are no longer kept (maxTurns), so turn ${toTurn} cannot be restored.`
      );
    }
    const backups = (await this.store.list(sessionId)).filter((b) => b.turn >= toTurn);
    const plan: PlannedAction[] = [];
    const groups = [...groupByPath(byTurn(backups))].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [path, changes] of groups) {
      const action = await this.planPath(path, changes, options.force === true);
      if (action) plan.push(action);
    }
    const result = summarize(plan, dryRun);
    if (dryRun) return result;
    await this.apply(plan);
    await this.store.removeFromTurn(sessionId, toTurn);
    return result;
  }

  /** Forgets every backup of a session (e.g. when the conversation ends). */
  async clear(options: { sessionId?: string } = {}): Promise<void> {
    await this.store.removeFromTurn(options.sessionId ?? 'default', 0);
  }

  private async capture(path: string): Promise<Captured> {
    const stat = await this.fs.stat(path);
    if (!stat || stat.type !== 'file') return { before: null, tooLarge: false };
    const mode = this.fs.getMode ? await this.fs.getMode(path) : undefined;
    if (stat.size > this.maxFileBytes) return { before: null, mode, tooLarge: true };
    const before = await this.fs.readFile(path);
    if (Buffer.byteLength(before, 'utf8') > this.maxFileBytes) return { before: null, mode, tooLarge: true };
    return { before, mode, tooLarge: false };
  }

  private async record(origin: WriteOrigin, path: string, captured: Captured, written: string): Promise<void> {
    const existing = await this.store.list(origin.sessionId);
    const repeat = existing.some((b) => b.turn === origin.turn && b.path === path);
    const omitted = captured.tooLarge ? 'too-large' : repeat && captured.before !== null ? 'same-turn' : undefined;
    await this.store.append({
      ...origin,
      path,
      before: omitted ? null : captured.before,
      ...(captured.mode !== undefined && { mode: captured.mode }),
      ...(omitted && { omitted }),
      afterHash: hashContent(written),
      at: new Date().toISOString(),
    });
    await this.prune(origin.sessionId, origin.turn);
  }

  /** Retention: keeps the newest `maxTurns` turns. */
  private async prune(sessionId: string, turn: number): Promise<void> {
    if (this.maxTurns === Infinity) return;
    const cutoff = turn - this.maxTurns + 1;
    if (cutoff > (await this.store.earliestTurn(sessionId))) await this.store.removeBeforeTurn(sessionId, cutoff);
  }

  /** Decides what to do with one path (`undefined`: nothing to do); reads only. `changes` is in turn order. */
  private async planPath(path: string, changes: WorkspaceFileBackup[], force: boolean): Promise<PlannedAction | undefined> {
    const first = changes.find((b) => b.omitted !== 'same-turn') ?? changes[0];
    if (first.omitted !== undefined) return { kind: 'skip', path, reason: 'too-large' };
    const stat = await this.fs.stat(path);
    if (stat && stat.type !== 'file') return { kind: 'skip', path, reason: 'not-a-file' };
    const current = stat ? await this.fs.readFile(path) : undefined;
    // Created by the agent and already gone: the file is as it was before the turn.
    if (current === undefined && first.before === null) return undefined;
    const untouched = current !== undefined && hashContent(current) === changes[changes.length - 1].afterHash;
    if (!untouched && !force) return { kind: 'skip', path, reason: 'changed-since' };
    if (first.before === null) return { kind: 'delete', path };
    return { kind: 'restore', path, content: first.before, ...(first.mode !== undefined && { mode: first.mode }) };
  }

  private async apply(plan: readonly PlannedAction[]): Promise<void> {
    const done: string[] = [];
    for (const action of plan) {
      try {
        await this.paths.run(action.path, () => this.applyOne(action));
      } catch (error) {
        throw new WorkspaceError(
          `rewind stopped at ${action.path}: ${(error as Error).message} Already rewound: ${done.length ? done.join(', ') : 'nothing'}. Backups were kept.`
        );
      }
      if (action.kind !== 'skip') done.push(action.path);
    }
  }

  private async applyOne(action: PlannedAction): Promise<void> {
    if (action.kind === 'delete') {
      await this.fs.rm(action.path);
    } else if (action.kind === 'restore') {
      await this.fs.writeFile(action.path, action.content);
      if (action.mode !== undefined && this.fs.chmod) await this.fs.chmod(action.path, action.mode);
    }
  }
}

function summarize(plan: readonly PlannedAction[], dryRun: boolean): RewindResult {
  const result: RewindResult = { dryRun, restored: [], deleted: [], skipped: [] };
  for (const action of plan) {
    if (action.kind === 'restore') result.restored.push(action.path);
    else if (action.kind === 'delete') result.deleted.push(action.path);
    else result.skipped.push({ path: action.path, reason: action.reason });
  }
  return result;
}
