/**
 * Session stores (LOU-W4): where a session's transcript lives between
 * `send()` calls (and, for `FileSessionStore`, between processes).
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileWithRetry, renameWithRetry } from '../storage/fsRetry';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message } from '../providers/llm';
import { SDKError } from '../execution/errors';
import { assertSessionId } from './sessionId';
import { caseSafeName, findLegacyFile, removeLegacyFile } from '../storage/fileNames';

/** How bytes (image and file parts, LOU-V11) are saved in a JSON transcript: `{ "$bytes": "<base64>" }`. */
const BYTES_KEY = '$bytes';

/** `JSON.stringify` replacer: a `Uint8Array` (a `Buffer` too, read before its `toJSON()`) becomes `{ $bytes }`. Shared with `SqliteStore`. */
export function encodeBytes(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key];
  return raw instanceof Uint8Array ? { [BYTES_KEY]: Buffer.from(raw).toString('base64') } : value;
}

/** `JSON.parse` reviver: `{ $bytes }` back to a `Uint8Array`. Shared with `SqliteStore`. */
export function decodeBytes(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.keys(value).length !== 1) return value;
  const base64 = (value as Record<string, unknown>)[BYTES_KEY];
  return typeof base64 === 'string' ? new Uint8Array(Buffer.from(base64, 'base64')) : value;
}

/**
 * Persistence for session transcripts. A transcript is the conversation
 * without the system prompt (the agent supplies that on every run).
 *
 * @example
 * ```ts
 * const store: SessionStore = new MemorySessionStore();
 * await store.save('chat-1', [{ role: 'user', content: 'hi' }]);
 * const messages = await store.load('chat-1');
 * ```
 */
export interface SessionStore {
  /** The saved transcript, or `undefined` when the id was never saved. */
  load(id: string): Promise<Message[] | undefined>;
  /** Replace the transcript saved under `id`. */
  save(id: string, messages: readonly Message[]): Promise<void>;
  /** Remove the transcript saved under `id`; a missing id is not an error. */
  delete(id: string): Promise<void>;
}

export { assertSessionId };

/**
 * In-memory store: the default. Transcripts live as long as the process
 * (and this store instance).
 *
 * @example
 * ```ts
 * const store = new MemorySessionStore();
 * const session = agent.session({ store });
 * ```
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Message[]>();

  async load(id: string): Promise<Message[] | undefined> {
    assertSessionId(id);
    const saved = this.sessions.get(id);
    return saved && structuredClone(saved);
  }

  async save(id: string, messages: readonly Message[]): Promise<void> {
    assertSessionId(id);
    this.sessions.set(id, structuredClone([...messages]));
  }

  async delete(id: string): Promise<void> {
    assertSessionId(id);
    this.sessions.delete(id);
  }
}

/**
 * One JSON file per session (`<dir>/<id>.json`), written atomically (temp
 * file + rename) so a crash never leaves a half-written transcript. The
 * directory is created on first save. Each uppercase letter of the id is
 * written as `^` and the lowercase letter (`Alice` -> `^alice.json`), so ids
 * that differ only in case get different files on Windows and macOS too.
 *
 * @example
 * ```ts
 * const store = new FileSessionStore('./.lousho/sessions');
 * const session = agent.session({ id: 'user-42', store });
 * ```
 */
export class FileSessionStore implements SessionStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  private fileFor(id: string): string {
    assertSessionId(id);
    return join(this.dir, `${caseSafeName(id)}.json`);
  }

  async load(id: string): Promise<Message[] | undefined> {
    let file = this.fileFor(id);
    let raw = await readText(file);
    if (raw === undefined) {
      const legacy = await findLegacyFile(this.dir, caseSafeName(id), id);
      if (legacy === undefined) return undefined;
      file = legacy;
      raw = await readText(file);
      if (raw === undefined) return undefined;
    }
    const parsed: unknown = JSON.parse(raw, decodeBytes);
    if (!Array.isArray(parsed)) {
      throw new SDKError(`Session file ${file} is corrupt: expected a JSON array of messages.`, 'LOUSHO_SESSION_FILE_CORRUPT');
    }
    return parsed as Message[];
  }

  async save(id: string, messages: readonly Message[]): Promise<void> {
    const file = this.fileFor(id);
    await mkdir(this.dir, { recursive: true });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(messages, encodeBytes), 'utf8');
      await renameWithRetry(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await removeLegacyFile(this.dir, caseSafeName(id), id);
  }

  async delete(id: string): Promise<void> {
    await rm(this.fileFor(id), { force: true });
    await removeLegacyFile(this.dir, caseSafeName(id), id);
  }
}

/** The file's text, or `undefined` when it does not exist. */
async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFileWithRetry(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
