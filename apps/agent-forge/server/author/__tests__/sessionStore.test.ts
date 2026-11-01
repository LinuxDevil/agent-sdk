import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthorSessionNotFoundError, AuthorSessionStore, titleFromText } from '../sessionStore';
import {
  DEFAULT_SESSION_TITLE,
  type AuthorAssistantMessage,
  type AuthorMessage,
  type AuthorSession,
  type AuthorUserMessage,
} from '../../../shared/authorWire';

/**
 * AuthorSessionStore: one JSON file per Author chat session under the
 * Studio-global sessions directory (studioPaths().sessions). The store is
 * what every later Author piece (turn runner, save gate, history) reads
 * and writes through, so this pins the file layout, the title derivation
 * and the serialized read-modify-write.
 */
describe('AuthorSessionStore', () => {
  let sessionsDir: string;
  let store: AuthorSessionStore;

  const WORKSPACE_ID = 'ws-test-abc123';

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa01-sessions-'));
    store = new AuthorSessionStore(sessionsDir);
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  function userMessage(text: string, id = `m_${Math.random().toString(36).slice(2)}`): AuthorUserMessage {
    return { id, role: 'user', text, at: new Date().toISOString() };
  }

  function assistantMessage(text: string): AuthorAssistantMessage {
    return {
      id: `m_${Math.random().toString(36).slice(2)}`,
      role: 'assistant',
      parts: [{ type: 'text', text }],
      at: new Date().toISOString(),
    };
  }

  function appendMessage(message: AuthorMessage) {
    return (s: AuthorSession): AuthorSession => ({ ...s, transcript: [...s.transcript, message] });
  }

  function sessionFiles(): string[] {
    return fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  }

  it('create persists as_<16 hex>.json with schemaVersion 1, title "New chat" and the request workspace', async () => {
    const session = await store.create(undefined, WORKSPACE_ID);
    expect(session.id).toMatch(/^as_[0-9a-f]{16}$/);
    expect(session.schemaVersion).toBe(1);
    expect(session.title).toBe(DEFAULT_SESSION_TITLE);
    expect(session.focus).toEqual({ mode: 'create' });
    expect(session.workspaceId).toBe(WORKSPACE_ID);
    expect(session.transcript).toEqual([]);
    expect(session.createdAgentIds).toEqual([]);
    expect(session.createdAt).toBe(session.updatedAt);

    const file = path.join(sessionsDir, `${session.id}.json`);
    expect(sessionFiles()).toEqual([`${session.id}.json`]);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as AuthorSession;
    expect(onDisk).toEqual(session);
    // The .lousho JSON convention: 2-space indent plus a trailing newline.
    expect(fs.readFileSync(file, 'utf8').endsWith('}\n')).toBe(true);
  });

  it('create honours an edit focus', async () => {
    const session = await store.create({ mode: 'edit', agentId: 'triage-bot' }, WORKSPACE_ID);
    expect(session.focus).toEqual({ mode: 'edit', agentId: 'triage-bot' });
  });

  it('get round-trips the session and returns undefined for a missing file, a bad id and unparsable JSON', async () => {
    const session = await store.create(undefined, WORKSPACE_ID);
    expect(await store.get(session.id)).toEqual(session);
    expect(await store.get('as_0000000000000000')).toBeUndefined();
    // Bad ids never reach the filesystem (path traversal guard).
    expect(await store.get('..')).toBeUndefined();
    expect(await store.get(`as_${'a'.repeat(70)}`)).toBeUndefined();
    expect(await store.get('has space')).toBeUndefined();
    fs.writeFileSync(path.join(sessionsDir, 'as_brokenfile0.json'), '{not json');
    expect(await store.get('as_brokenfile0')).toBeUndefined();
  });

  it('list returns summaries newest updatedAt first and skips unreadable files', async () => {
    const first = await store.create(undefined, WORKSPACE_ID);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.create({ mode: 'edit', agentId: 'bot' }, WORKSPACE_ID);
    await store.update(second.id, appendMessage(userMessage('hello')));
    fs.writeFileSync(path.join(sessionsDir, 'corrupt.json'), 'not json at all');

    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(list[0]).toEqual({
      id: second.id,
      title: 'hello',
      focus: { mode: 'edit', agentId: 'bot' },
      workspaceId: WORKSPACE_ID,
      updatedAt: (await store.get(second.id))?.updatedAt,
      messageCount: 1,
      createdAgentIds: [],
    });
    expect(list[1].messageCount).toBe(0);
  });

  it('list is empty when the sessions directory does not exist yet', async () => {
    const empty = new AuthorSessionStore(path.join(sessionsDir, 'never-written'));
    expect(await empty.list()).toEqual([]);
  });

  it('update appends through the lock, stamps updatedAt and derives the title from the first user text', async () => {
    const session = await store.create(undefined, WORKSPACE_ID);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await store.update(session.id, appendMessage(userMessage('  Build   a  triage agent ')));
    expect(updated.transcript).toHaveLength(1);
    expect(updated.title).toBe('Build a triage agent');
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(session.updatedAt));
    expect((await store.get(session.id))?.title).toBe('Build a triage agent');
  });

  it('update keeps the default title for uiEvent-only user messages and never re-derives it once set', async () => {
    const session = await store.create(undefined, WORKSPACE_ID);
    const uiEventOnly: AuthorUserMessage = {
      ...userMessage(''),
      uiEvent: { kind: 'save', proposalId: 'call_1', agentId: 'bot', version: 2 },
    };
    const stillDefault = await store.update(session.id, appendMessage(uiEventOnly));
    expect(stillDefault.title).toBe(DEFAULT_SESSION_TITLE);

    const titled = await store.update(session.id, appendMessage(userMessage('Second turn text')));
    expect(titled.title).toBe('Second turn text');

    const again = await store.update(session.id, appendMessage(userMessage('Third turn should not rename')));
    expect(again.title).toBe('Second turn text');
  });

  it('two concurrent updates on one session both land', async () => {
    const session = await store.create(undefined, WORKSPACE_ID);
    await Promise.all([
      store.update(session.id, appendMessage(userMessage('first'))),
      store.update(session.id, appendMessage(assistantMessage('reply'))),
    ]);
    const after = await store.get(session.id);
    expect(after?.transcript).toHaveLength(2);
    expect(after?.transcript.map((m) => (m.role === 'user' ? m.text : 'assistant'))).toEqual(
      expect.arrayContaining(['first', 'assistant'])
    );
  });

  it('update throws AuthorSessionNotFoundError for a missing session (bad ids included)', async () => {
    await expect(store.update('as_0000000000000000', appendMessage(userMessage('x')))).rejects.toBeInstanceOf(
      AuthorSessionNotFoundError
    );
    await expect(store.update('..', appendMessage(userMessage('x')))).rejects.toBeInstanceOf(
      AuthorSessionNotFoundError
    );
  });

  it('remove deletes the file once and reports false afterwards / for bad ids', async () => {
    const session = await store.create(undefined, WORKSPACE_ID);
    expect(await store.remove(session.id)).toBe(true);
    expect(await store.get(session.id)).toBeUndefined();
    expect(await store.remove(session.id)).toBe(false);
    expect(await store.remove('..')).toBe(false);
    expect(sessionFiles()).toEqual([]);
  });
});

describe('titleFromText', () => {
  it('trims and collapses whitespace', () => {
    expect(titleFromText('  Build   a  triage agent ')).toBe('Build a triage agent');
  });

  it('cuts at 60 chars on a word boundary and appends an ellipsis', () => {
    const sentence = 'Please build me an agent that triages every single inbound support ticket daily';
    const title = titleFromText(sentence);
    expect(sentence.length).toBeGreaterThan(60);
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
    expect(title.slice(0, -1)).not.toContain('  ');
  });

  it('cuts a single >60-char word at 60 chars', () => {
    const title = titleFromText('x'.repeat(80));
    expect(title).toBe(`${'x'.repeat(60)}…`);
  });

  it('keeps a <=60-char message whole', () => {
    expect(titleFromText('short title')).toBe('short title');
    expect(titleFromText('y'.repeat(60))).toBe('y'.repeat(60));
  });

  it('empty and whitespace-only text keep the default title', () => {
    expect(titleFromText('')).toBe(DEFAULT_SESSION_TITLE);
    expect(titleFromText('   \n\t ')).toBe(DEFAULT_SESSION_TITLE);
  });
});
