/**
 * The kit's backing store: a handful of JSON files in one directory so the
 * whole kit runs (and is inspectable) offline.
 *
 *   inbox.json           inbound messages and their triage state
 *   drafts.json          replies the agent wrote but nobody sent
 *   outbox.json          replies a human approved and send_reply recorded
 *   auto-approve.json    optional standing allowlist for approve.ts
 *   memory/              per-sender memory slot files (memory/senders.ts)
 *
 * The directory is `INBOX_TRIAGE_HOME` when set, else `data/` inside the
 * installed kit, so a deployment can point the store at a volume and tests
 * at a temp dir.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export type MessageStatus = 'new' | 'triaged' | 'replied' | 'processed' | 'trashed';
export type MessageCategory = 'urgent' | 'reply-needed' | 'fyi' | 'spam';

export interface StoredMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
  status: MessageStatus;
  category?: MessageCategory;
  categoryReason?: string;
}

export interface Draft {
  id: string;
  messageId: string;
  to: string;
  subject: string;
  body: string;
  createdAt: string;
  status: 'draft' | 'sent' | 'rejected';
}

export interface OutboxEntry {
  id: string;
  messageId: string;
  draftId?: string;
  to: string;
  subject: string;
  body: string;
  sentAt: string;
}

/** The store directory: `INBOX_TRIAGE_HOME` when set, else `<kit>/data`. */
export function home(): string {
  const env = process.env.INBOX_TRIAGE_HOME;
  if (env !== undefined && env.trim() !== '') return path.resolve(env);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
}

function file(name: string): string {
  return path.join(home(), name);
}

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file(name), 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

/** Writes atomically (temp file + rename) so a crashed run never leaves a torn JSON file. */
async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(home(), { recursive: true });
  const temp = `${file(name)}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file(name));
}

export async function listMessages(status?: MessageStatus): Promise<StoredMessage[]> {
  const messages = await readJson<StoredMessage[]>('inbox.json', []);
  const filtered = status === undefined ? messages : messages.filter((message) => message.status === status);
  return filtered.slice().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export async function getMessage(id: string): Promise<StoredMessage> {
  const message = (await readJson<StoredMessage[]>('inbox.json', [])).find((candidate) => candidate.id === id);
  if (message === undefined) throw new Error(`no message with id '${id}' - call list_messages for the current ids`);
  return message;
}

export async function updateMessage(id: string, patch: Partial<StoredMessage>): Promise<StoredMessage> {
  const messages = await readJson<StoredMessage[]>('inbox.json', []);
  const index = messages.findIndex((candidate) => candidate.id === id);
  if (index === -1) throw new Error(`no message with id '${id}' - call list_messages for the current ids`);
  messages[index] = { ...messages[index], ...patch, id };
  await writeJson('inbox.json', messages);
  return messages[index];
}

/** Drops a new inbound message into the inbox (the channel's intake path). */
export async function addMessage(input: { from: string; subject: string; body: string }): Promise<StoredMessage> {
  const messages = await readJson<StoredMessage[]>('inbox.json', []);
  const message: StoredMessage = {
    id: `m-${randomUUID().slice(0, 8)}`,
    from: input.from,
    subject: input.subject,
    body: input.body,
    receivedAt: new Date().toISOString(),
    status: 'new',
  };
  messages.push(message);
  await writeJson('inbox.json', messages);
  return message;
}

export async function listDrafts(messageId?: string): Promise<Draft[]> {
  const drafts = await readJson<Draft[]>('drafts.json', []);
  return messageId === undefined ? drafts : drafts.filter((draft) => draft.messageId === messageId);
}

export async function findDraft(id: string): Promise<Draft | undefined> {
  return (await readJson<Draft[]>('drafts.json', [])).find((draft) => draft.id === id);
}

/**
 * Adds a draft for `messageId`. Ids are deterministic (`draft-<message>-<n>`)
 * so a follow-up call (and a script or test) can name the draft it just made.
 */
export async function addDraft(draft: Omit<Draft, 'id' | 'createdAt' | 'status'>): Promise<Draft> {
  const drafts = await readJson<Draft[]>('drafts.json', []);
  const count = drafts.filter((candidate) => candidate.messageId === draft.messageId).length;
  const created: Draft = { ...draft, id: `draft-${draft.messageId}-${count + 1}`, createdAt: new Date().toISOString(), status: 'draft' };
  drafts.push(created);
  await writeJson('drafts.json', drafts);
  return created;
}

export async function updateDraft(id: string, patch: Partial<Draft>): Promise<Draft> {
  const drafts = await readJson<Draft[]>('drafts.json', []);
  const index = drafts.findIndex((candidate) => candidate.id === id);
  if (index === -1) throw new Error(`no draft with id '${id}'`);
  drafts[index] = { ...drafts[index], ...patch, id };
  await writeJson('drafts.json', drafts);
  return drafts[index];
}

export async function readOutbox(): Promise<OutboxEntry[]> {
  return readJson<OutboxEntry[]>('outbox.json', []);
}

export async function appendOutbox(entry: Omit<OutboxEntry, 'id' | 'sentAt'>): Promise<OutboxEntry> {
  const outbox = await readOutbox();
  const sent: OutboxEntry = { ...entry, id: `out-${outbox.length + 1}`, sentAt: new Date().toISOString() };
  outbox.push(sent);
  await writeJson('outbox.json', outbox);
  return sent;
}

/**
 * The standing allowlist approve.ts uses when a deployment wires it in:
 * addresses and `@domain` entries from `auto-approve.json`, plus any
 * comma-separated entries in INBOX_TRIAGE_AUTO_APPROVE.
 */
export async function autoApproveSenders(): Promise<string[]> {
  const fromFile = await readJson<string[]>('auto-approve.json', []);
  const fromEnv = (process.env.INBOX_TRIAGE_AUTO_APPROVE ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  return [...fromFile.map((entry) => entry.toLowerCase()), ...fromEnv];
}
