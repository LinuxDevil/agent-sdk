/**
 * Session stores (LOU-W4): where a session's transcript lives between
 * `send()` calls (and, for `FileSessionStore`, between processes).
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message } from '../providers/llm';
import { ConfigurationError, SDKError } from '../execution/errors';

/** How bytes (image and file parts, LOU-V11) are saved in a JSON transcript: `{ "$bytes": "<base64>" }`. */
const BYTES_KEY = '$bytes';

/** `JSON.stringify` replacer: a `Uint8Array` (a `Buffer` too, read before its `toJSON()`) becomes `{ $bytes }`. */
function encodeBytes(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key];
  return raw instanceof Uint8Array ? { [BYTES_KEY]: Buffer.from(raw).toString('base64') } : value;
}

/** `JSON.parse` reviver: `{ $bytes }` back to a `Uint8Array`. */
function decodeBytes(_key: string, value: unknown): unknown {
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

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Throws unless `id` is 1-128 characters of letters, digits, `_` or `-`.
 * Session ids become file names, so anything else (`../`, `/`, `.`) is refused.
 */
export function assertSessionId(id: string): void {
  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
    throw new ConfigurationError(
      `Invalid session id ${JSON.stringify(id)}: use 1-128 characters from A-Z, a-z, 0-9, '_' and '-' ` +
        "(e.g. 'user-42'). Omit the id to get a generated one.",
      'id',
      'LOUSHY_SESSION_ID_INVALID'
    );
  }
}

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
 * directory is created on first save.
 *
 * @example
 * ```ts
 * const store = new FileSessionStore('./.loushy/sessions');
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
    return join(this.dir, `${id}.json`);
  }

  async load(id: string): Promise<Message[] | undefined> {
    const file = this.fileFor(id);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const parsed: unknown = JSON.parse(raw, decodeBytes);
    if (!Array.isArray(parsed)) {
      throw new SDKError(`Session file ${file} is corrupt: expected a JSON array of messages.`, 'LOUSHY_SESSION_FILE_CORRUPT');
    }
    return parsed as Message[];
  }

  async save(id: string, messages: readonly Message[]): Promise<void> {
    const file = this.fileFor(id);
    await mkdir(this.dir, { recursive: true });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(messages, encodeBytes), 'utf8');
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.fileFor(id), { force: true });
  }
}
