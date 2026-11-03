import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import type { AgentSpecV2 } from 'lousho';
import { createApp } from '../app';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo, defaultMeta } from '../storage/agentRepo';
import { AuthorSessionStore } from '../author/sessionStore';
import type { AuthorSession, SetEnabledOutput } from '../../shared/authorWire';

/**
 * `POST /assistant/sessions/:id/enable` (AA11): the SuccessCard's
 * "Enable agent" button. Same write as the `setAgentEnabled` tool but
 * gated on `session.createdAgentIds` - a chat can only switch on an
 * agent it created. It appends nothing to the transcript and runs no
 * turn.
 */
describe('POST /assistant/sessions/:id/enable', () => {
  const TOKEN = 'aa11-test-token';
  let baseDir: string;
  let staticDir: string;
  let sessionsDir: string;
  let repo: AgentRepo;
  let sessions: AuthorSessionStore;
  let app: ReturnType<typeof createApp>;

  const SPEC: AgentSpecV2 = {
    version: 2,
    name: 'Card bot',
    model: 'anthropic/claude-x',
    instructions: 'Be helpful.',
    triggers: [{ id: 't1', type: 'chat' }],
  };

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa11-route-'));
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa11-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html>');
    sessionsDir = path.join(baseDir, '.lousho', 'assistant', 'sessions');
    repo = new AgentRepo(baseDir);
    sessions = new AuthorSessionStore(sessionsDir);
    app = buildApp();
    // Deterministic requirements: no provider key leaks in from the host env.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  function buildApp(): ReturnType<typeof createApp> {
    const agentStore = createFsAgentStore(baseDir, repo);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    return createApp({ agentStore, runManager, baseDir, staticDir, access: { token: TOKEN }, sessions });
  }

  const authed = (r: request.Test) => r.set(STUDIO_TOKEN_HEADER, TOKEN);

  async function createSession(createdAgentIds: string[] = []): Promise<AuthorSession> {
    const res = await authed(request(app).post('/assistant/sessions')).send({});
    expect(res.status).toBe(201);
    const session = res.body as AuthorSession;
    if (createdAgentIds.length > 0) {
      await sessions.update(session.id, (s) => ({ ...s, createdAgentIds }));
    }
    return session;
  }

  async function saveAgent(id: string, enabled: boolean): Promise<void> {
    await repo.writeSpec(id, SPEC);
    await repo.writeMeta(id, { ...defaultMeta('2026-01-01T00:00:00.000Z'), enabled });
  }

  function enable(sessionId: string, body: unknown): request.Test {
    return authed(request(app).post(`/assistant/sessions/${sessionId}/enable`)).send(body as object);
  }

  it('enables a disabled agent the session created: 200 SetEnabledOutput, meta flipped, transcript untouched', async () => {
    await saveAgent('card-bot', false);
    const session = await createSession(['card-bot']);
    const transcriptBefore = (await sessions.get(session.id))?.transcript.length;

    const res = await enable(session.id, { agentId: 'card-bot' });
    expect(res.status).toBe(200);
    const body = res.body as SetEnabledOutput;
    // The anthropic provider key is the one missing readiness row.
    expect(body).toEqual({
      ok: true,
      agentId: 'card-bot',
      enabled: true,
      status: 'updated',
      missingRequirements: 1,
    });

    const meta = await repo.readMeta('card-bot');
    expect(meta).toMatchObject({ enabled: true, disabledAt: null, disabledReason: null });
    // No transcript append, no turn: the session file is exactly as seeded.
    expect((await sessions.get(session.id))?.transcript.length).toBe(transcriptBefore);
  });

  it('reports unchanged when the agent is already enabled', async () => {
    await saveAgent('card-bot', true);
    const session = await createSession(['card-bot']);
    const res = await enable(session.id, { agentId: 'card-bot' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, enabled: true, status: 'unchanged' });
  });

  it('refuses an agent the session did not create -> 400 WRONG_AGENT, meta untouched', async () => {
    await saveAgent('card-bot', false);
    const session = await createSession();
    const res = await enable(session.id, { agentId: 'card-bot' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'This chat did not create that agent.', code: 'WRONG_AGENT' });
    expect((await repo.readMeta('card-bot')).enabled).toBe(false);
  });

  it('a created id whose agent no longer exists -> 404 AGENT_NOT_FOUND', async () => {
    const session = await createSession(['ghost']);
    const res = await enable(session.id, { agentId: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "That agent doesn't exist.", code: 'AGENT_NOT_FOUND' });
  });

  it('404 when the session does not exist', async () => {
    const res = await enable('as_0000000000000000', { agentId: 'card-bot' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Chat not found.', code: 'NOT_FOUND' });
  });

  it.each([{}, { agentId: 5 }, { agentId: '' }, { agentId: 'bad id' }, 'text'])(
    'a malformed body %j -> 400',
    async (body) => {
      const session = await createSession();
      const res = await enable(session.id, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_INPUT');
    }
  );
});
