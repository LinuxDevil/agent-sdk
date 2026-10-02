/**
 * FileWorkspaceCheckpointStore (N7): workspace backups as one JSON file per
 * session, so a rewind still works after the process restarts.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  hashContent,
  logWithoutTurnsBefore,
  logWithoutTurnsFrom,
  type WorkspaceCheckpointLog,
  type WorkspaceCheckpointStore,
  type WorkspaceFileBackup,
} from './checkpoints';
import { KeyedQueue } from './keyedQueue';
import { WorkspaceError } from './paths';
import { ConfigurationError } from '../../execution/errors';

/** Session ids that are safe as a file name as they are; any other id is hashed. */
const PLAIN_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/;
/** Windows refuses a rename while another process (an indexer, an antivirus) holds the target open; such errors pass quickly. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 10;

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_RENAME_CODES.has(code) || attempt >= RENAME_ATTEMPTS) throw error;
      await delay(20 * attempt);
    }
  }
}

function isLog(value: unknown): value is WorkspaceCheckpointLog {
  const log = value as WorkspaceCheckpointLog | null;
  return typeof log === 'object' && log !== null && typeof log.earliestTurn === 'number' && Array.isArray(log.backups);
}

/**
 * Keeps each session's backups in `<dir>/<session id>.json` (a hashed name
 * when the id is not a plain file name). Every write goes to a temp file that
 * is renamed into place, so a crash never leaves half a file; operations on
 * one session are serialized within this instance. Do not share one session's
 * file between processes that write at the same time.
 *
 * @example
 * ```ts
 * import { FileWorkspaceCheckpointStore, NodeWorkspace, WorkspaceCheckpoints } from '@lousho/build-ai-agent';
 * const workspace = new NodeWorkspace({ root: '.' });
 * const checkpoints = new WorkspaceCheckpoints(workspace, { store: new FileWorkspaceCheckpointStore('.lousho/rewind') });
 * ```
 */
export class FileWorkspaceCheckpointStore implements WorkspaceCheckpointStore {
  private readonly dir: string;
  private readonly sessions = new KeyedQueue();

  constructor(dir: string) {
    if (typeof dir !== 'string' || dir === '') {
      throw new ConfigurationError("FileWorkspaceCheckpointStore: 'dir' is required, e.g. new FileWorkspaceCheckpointStore('.lousho/rewind').", 'dir');
    }
    this.dir = resolve(dir);
  }

  append(backup: WorkspaceFileBackup): Promise<void> {
    return this.update(backup.sessionId, (log) => ({ ...log, backups: [...log.backups, backup] }));
  }

  list(sessionId: string): Promise<WorkspaceFileBackup[]> {
    return this.sessions.run(sessionId, async () => (await this.read(sessionId)).backups);
  }

  removeFromTurn(sessionId: string, turn: number): Promise<void> {
    return this.update(sessionId, (log) => logWithoutTurnsFrom(log, turn));
  }

  removeBeforeTurn(sessionId: string, turn: number): Promise<void> {
    return this.update(sessionId, (log) => logWithoutTurnsBefore(log, turn));
  }

  earliestTurn(sessionId: string): Promise<number> {
    return this.sessions.run(sessionId, async () => (await this.read(sessionId)).earliestTurn);
  }

  private fileFor(sessionId: string): string {
    const name = PLAIN_ID.test(sessionId) ? `s-${sessionId}` : `h-${hashContent(sessionId).slice(0, 40)}`;
    return join(this.dir, `${name}.json`);
  }

  private async read(sessionId: string): Promise<WorkspaceCheckpointLog> {
    const file = this.fileFor(sessionId);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { earliestTurn: 0, backups: [] };
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isLog(parsed)) throw new WorkspaceError(`Checkpoint file ${file} is corrupt: expected { earliestTurn, backups }.`);
    return parsed;
  }

  /** Read-modify-write of one session's file; `undefined` from `change` deletes the file. */
  private update(sessionId: string, change: (log: WorkspaceCheckpointLog) => WorkspaceCheckpointLog | undefined): Promise<void> {
    return this.sessions.run(sessionId, async () => {
      const next = change(await this.read(sessionId));
      const file = this.fileFor(sessionId);
      if (!next) {
        await rm(file, { force: true });
        return;
      }
      await mkdir(this.dir, { recursive: true });
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(next), 'utf8');
        await renameWithRetry(temp, file);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    });
  }
}
