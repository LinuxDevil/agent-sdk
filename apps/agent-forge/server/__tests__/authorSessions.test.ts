import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { mockModel } from 'lousho/testing';
import { createApp } from '../app';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { workspaceIdFor } from '../workspace/workspaceId';
import { AuthorSessionStore } from '../author/sessionStore';
import { AuthorTurnRunner } from '../author/turnRunner';
import { SecretsStore } from '../secretsStore';
import { SettingsStore } from '../settingsStore';
import type { AuthorServerEvent, AuthorSession, AuthorSessionSummary } from '../../shared/authorWire';

/**
 * The Author session routes (`/assistant/sessions`) behind the studio
 * token gate: create/list/get/delete over one JSON file per session in
 * the Studio-global `assistant/sessions/` directory. `workspaceId` is
 * stamped from the request's workspace so later Author code resolves the
 * agent stores a chat edits through the app's WorkspaceResolver.
 */
describe('author session routes', () => {
  const TOKEN = 'aa01-test-token';
  const INDEX_SENTINEL = '<!doctype html><title>aa01-spa</title>';
  let baseDir: string;
  let staticDir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa01-routes-'));
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa01-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), INDEX_SENTINEL);
    const agentStore = createFsAgentStore(baseDir);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    app = createApp({ agentStore, runManager, baseDir, staticDir, access: { token: TOKEN } });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  const authed = (r: request.Test) => r.set(STUDIO_TOKEN_HEADER, TOKEN);

  function sessionsDir(): string {
    return path.join(baseDir, '.lousho', 'assistant', 'sessions');
  }

  async function createSession(focus?: unknown): Promise<AuthorSession> {
    const res = await authed(request(app).post('/assistant/sessions')).send(focus === undefined ? {} : { focus });
    expect(res.status).toBe(201);
    return res.body as AuthorSession;
  }

  it('POST /assistant/sessions writes .lousho/assistant/sessions/as_<16 hex>.json and answers 201', async () => {
    const res = await authed(request(app).post('/assistant/sessions')).send({});
    expect(res.status).toBe(201);
    const session = res.body as AuthorSession;
    expect(session.id).toMatch(/^as_[0-9a-f]{16}$/);
    expect(session.schemaVersion).toBe(1);
    expect(session.title).toBe('New chat');
    expect(session.focus).toEqual({ mode: 'create' });
    expect(session.workspaceId).toBe(workspaceIdFor(baseDir));
    expect(session.transcript).toEqual([]);
    expect(session.createdAgentIds).toEqual([]);
    const file = path.join(sessionsDir(), `${session.id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(session);
  });

  it('POST accepts an edit focus with a valid agentId', async () => {
    const session = await createSession({ mode: 'edit', agentId: 'triage-bot' });
    expect(session.focus).toEqual({ mode: 'edit', agentId: 'triage-bot' });
  });

  it.each([
    { focus: { mode: 'edit' }, label: 'missing agentId' },
    { focus: { mode: 'edit', agentId: 'bad id!' }, label: 'invalid agentId' },
    { focus: { mode: 'bogus' }, label: 'unknown mode' },
    { focus: 'edit', label: 'non-object focus' },
  ])('POST with a bad focus ($label) -> 400 INVALID_INPUT', async ({ focus }) => {
    const res = await authed(request(app).post('/assistant/sessions')).send({ focus });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'focus must be { mode: "create" } or { mode: "edit", agentId }.',
      code: 'INVALID_INPUT',
    });
  });

  it('GET /assistant/sessions lists summaries newest first', async () => {
    const first = await createSession();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createSession({ mode: 'edit', agentId: 'bot' });
    const res = await authed(request(app).get('/assistant/sessions'));
    expect(res.status).toBe(200);
    const list = res.body as AuthorSessionSummary[];
    expect(list.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(list[0].messageCount).toBe(0);
    expect(list[0].workspaceId).toBe(workspaceIdFor(baseDir));
    // Summaries carry no transcript.
    expect('transcript' in list[0]).toBe(false);
  });

  it('GET /assistant/sessions/:id returns the session; an unknown id -> 404 NOT_FOUND', async () => {
    const session = await createSession();
    const res = await authed(request(app).get(`/assistant/sessions/${session.id}`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(session);

    const missing = await authed(request(app).get('/assistant/sessions/as_0000000000000000'));
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Chat not found.', code: 'NOT_FOUND' });
  });

  it.each(['..', 'a'.repeat(65), 'has%20space', 'a%2Fb', '%2E%2E'])(
    'GET/DELETE /assistant/sessions/%s -> 400 INVALID_ID, never touching the disk',
    async (badId) => {
      const get = await authed(request(app).get(`/assistant/sessions/${badId}`));
      expect(get.status).toBe(400);
      expect(get.body).toEqual({ error: 'Invalid chat id.', code: 'INVALID_ID' });
      const del = await authed(request(app).delete(`/assistant/sessions/${badId}`));
      expect(del.status).toBe(400);
      expect(del.body.code).toBe('INVALID_ID');
      const dir = sessionsDir();
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    }
  );

  it('DELETE /assistant/sessions/:id removes the file -> 204, then 404 on a second delete', async () => {
    const session = await createSession();
    const res = await authed(request(app).delete(`/assistant/sessions/${session.id}`));
    expect(res.status).toBe(204);
    expect(fs.existsSync(path.join(sessionsDir(), `${session.id}.json`))).toBe(false);
    const again = await authed(request(app).delete(`/assistant/sessions/${session.id}`));
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: 'Chat not found.', code: 'NOT_FOUND' });
  });

  it('DELETE /assistant/sessions/:id -> 409 BUSY while a reply is running in that chat', async () => {
    // An app wired with a real runner whose provider stalls, so the turn is
    // still in flight when the delete arrives.
    const sessions = new AuthorSessionStore(path.join(baseDir, '.lousho', 'assistant', 'sessions'));
    const settings = new SettingsStore(baseDir);
    const secrets = new SecretsStore(baseDir);
    const model = mockModel([{ text: 'slow', delayMs: 120 }]);
    const runner = new AuthorTurnRunner({
      sessions,
      settings,
      secrets,
      systemPrompt: () => 'You are the lousho Agent Author.',
      buildTools: () => [],
      turnContextInput: async (s, now) => ({ focus: s.focus, openProposals: [], now }),
      providerFor: () => model,
    });
    const agentStore = createFsAgentStore(baseDir);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    const busyApp = createApp({ agentStore, runManager, baseDir, staticDir, access: { token: TOKEN }, sessions, authorRunner: runner });

    const created = await request(busyApp).post('/assistant/sessions').set(STUDIO_TOKEN_HEADER, TOKEN).send({});
    expect(created.status).toBe(201);
    const chat = created.body as AuthorSession;
    const turnEnd = new Promise<AuthorServerEvent>((resolve) => {
      runner.on('event', (_sid, ev) => {
        if (ev.type === 'turn.finished' || ev.type === 'turn.error') resolve(ev);
      });
    });
    const started = await runner.start(chat.id, { requestId: 'req-busy-aa02b', text: 'go' });
    expect(started.ok).toBe(true);

    const del = await request(busyApp).delete(`/assistant/sessions/${chat.id}`).set(STUDIO_TOKEN_HEADER, TOKEN);
    expect(del.status).toBe(409);
    expect(del.body).toEqual({ error: 'Stop the reply before deleting this chat.', code: 'BUSY' });
    expect(fs.existsSync(path.join(sessionsDir(), `${chat.id}.json`))).toBe(true);

    runner.stop(chat.id, 'req-busy-aa02b');
    await turnEnd;
  });

  it('requires the studio token (401 without it) on every verb', async () => {
    const session = await createSession();
    for (const req of [
      request(app).post('/assistant/sessions').send({}),
      request(app).get('/assistant/sessions'),
      request(app).get(`/assistant/sessions/${session.id}`),
      request(app).delete(`/assistant/sessions/${session.id}`),
    ]) {
      const res = await req;
      expect(res.status).toBe(401);
    }
  });

  it('the SPA fallback never serves index.html under /assistant/**', async () => {
    // A GET that matches no /assistant route falls through to the fallback;
    // the excluded prefix means it 404s instead of loading the client shell.
    const res = await authed(request(app).get('/assistant/definitely-not-a-route'));
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(INDEX_SENTINEL);
    // And the real list route answers JSON, not the client.
    const list = await authed(request(app).get('/assistant/sessions'));
    expect(list.status).toBe(200);
    expect(list.headers['content-type']).toMatch(/application\/json/);
  });
});
