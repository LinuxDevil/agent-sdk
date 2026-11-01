/**
 * AuthorSessionStore - the persisted Author chat sessions, one JSON file
 * each under the Studio-global sessions directory (`studioPaths().sessions`,
 * passed in as `sessionsDir` so no code joins a base dir with `.lousho/`).
 *
 * The transcript is the proposal store: every later Author piece (the turn
 * runner, the save gate, the panel, history) reads and writes through this
 * store, so `update()` serializes each session's read-modify-write inside
 * `withAgentLock('author:<id>')` - the `author:` prefix keeps session ids
 * from ever colliding with the agent ids the same lock guards elsewhere -
 * and writes atomically (`writeJsonAtomic`: 2-space indent, trailing
 * newline).
 *
 * Transcript contents are never logged.
 */
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  AUTHOR_SESSION_ID_RE,
  DEFAULT_SESSION_TITLE,
  type AuthorFocus,
  type AuthorSession,
  type AuthorSessionSummary,
} from '../../shared/authorWire';
import { withAgentLock, writeJsonAtomic } from '../storage/atomic';

/** `update()` named a session id the store has no readable file for. Routes answer 404. */
export class AuthorSessionNotFoundError extends Error {
  constructor(id: string) {
    super(`No author session '${id}'`);
    this.name = 'AuthorSessionNotFoundError';
  }
}

/** Longest a derived session title gets before it is cut on a word boundary. */
const TITLE_MAX_CHARS = 60;

/**
 * The session title a first user text becomes: trimmed, whitespace
 * collapsed to single spaces, cut at `TITLE_MAX_CHARS` on the last word
 * boundary inside the limit (a single over-long word is cut at the limit),
 * '…' appended when anything was cut. Empty input keeps the default title.
 */
export function titleFromText(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  if (collapsed === '') return DEFAULT_SESSION_TITLE;
  if (collapsed.length <= TITLE_MAX_CHARS) return collapsed;
  const window = collapsed.slice(0, TITLE_MAX_CHARS);
  const boundary = window.lastIndexOf(' ');
  const head = boundary > 0 ? window.slice(0, boundary) : window;
  return `${head}…`;
}

/**
 * The Author session store over `sessionsDir`. `create` stamps ids
 * (`as_<16 lowercase hex>`), the schema version and the workspace the chat
 * belongs to; `get`/`list`/`remove` never throw for a missing or corrupt
 * file so one bad write can't take down the panel.
 */
export class AuthorSessionStore {
  constructor(private readonly sessionsDir: string) {}

  private sessionPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.json`);
  }

  /**
   * Creates and persists a session in `workspaceId` (the id of the
   * workspace the request resolved to - a chat edits agents in exactly
   * one workspace). `focus` defaults to `{ mode: 'create' }`.
   */
  async create(focus: AuthorFocus | undefined, workspaceId: string): Promise<AuthorSession> {
    const now = new Date().toISOString();
    const session: AuthorSession = {
      schemaVersion: 1,
      id: `as_${randomBytes(8).toString('hex')}`,
      title: DEFAULT_SESSION_TITLE,
      createdAt: now,
      updatedAt: now,
      workspaceId,
      focus: focus ?? { mode: 'create' },
      transcript: [],
      createdAgentIds: [],
    };
    await writeJsonAtomic(this.sessionPath(session.id), session);
    return session;
  }

  /**
   * The stored session, or `undefined` for an id that fails
   * `AUTHOR_SESSION_ID_RE` (checked before any path join), a missing file
   * or unparsable JSON.
   */
  async get(id: string): Promise<AuthorSession | undefined> {
    if (!AUTHOR_SESSION_ID_RE.test(id)) return undefined;
    try {
      return JSON.parse(await fsPromises.readFile(this.sessionPath(id), 'utf8')) as AuthorSession;
    } catch {
      return undefined;
    }
  }

  /** Every readable session as a summary, newest `updatedAt` first; corrupt files are skipped. */
  async list(): Promise<AuthorSessionSummary[]> {
    let files: string[];
    try {
      files = await fsPromises.readdir(this.sessionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const summaries: AuthorSessionSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(this.sessionsDir, file);
      let session: AuthorSession;
      try {
        session = JSON.parse(await fsPromises.readFile(filePath, 'utf8')) as AuthorSession;
        if (typeof session.id !== 'string' || typeof session.updatedAt !== 'string') {
          throw new Error('not an author session');
        }
      } catch {
        // The filename is all that is logged - never transcript contents.
        console.warn(`[agent-forge] skipping unreadable author session file ${filePath}`);
        continue;
      }
      summaries.push({
        id: session.id,
        title: session.title,
        focus: session.focus,
        workspaceId: session.workspaceId,
        updatedAt: session.updatedAt,
        messageCount: Array.isArray(session.transcript) ? session.transcript.length : 0,
        createdAgentIds: session.createdAgentIds ?? [],
      });
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  /**
   * Read-modify-write of one session inside `withAgentLock('author:<id>')`,
   * so two concurrent writers both land. `fn` returns the next session;
   * the store stamps `updatedAt`, derives the title from the first user
   * message with non-empty text while it is still the default, and writes
   * atomically. Throws {@link AuthorSessionNotFoundError} for a bad id or
   * a missing/unreadable file.
   */
  async update(id: string, fn: (s: AuthorSession) => AuthorSession): Promise<AuthorSession> {
    return withAgentLock(`author:${id}`, async () => {
      const current = await this.get(id);
      if (current === undefined) throw new AuthorSessionNotFoundError(id);
      const next = fn(current);
      next.updatedAt = new Date().toISOString();
      if (next.title === DEFAULT_SESSION_TITLE) {
        for (const message of next.transcript) {
          if (message.role === 'user' && message.text.trim() !== '') {
            next.title = titleFromText(message.text);
            break;
          }
        }
      }
      await writeJsonAtomic(this.sessionPath(id), next);
      return next;
    });
  }

  /** Deletes the session file; `false` for a bad id or a file that was not there. */
  async remove(id: string): Promise<boolean> {
    if (!AUTHOR_SESSION_ID_RE.test(id)) return false;
    try {
      await fsPromises.rm(this.sessionPath(id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
