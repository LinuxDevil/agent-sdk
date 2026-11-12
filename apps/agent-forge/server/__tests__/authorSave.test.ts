import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { specHash } from '../storage/specHash';
import { AuthorSessionStore } from '../author/sessionStore';
import type { AuthorTurnRunner } from '../author/turnRunner';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorSaveResponse,
  AuthorSession,
  AuthorUserMessage,
  ProposalOutput,
} from '../../shared/authorWire';

/**
 * `POST /assistant/sessions/:id/save` (AA10b): the card's Apply button.
 * The stored transcript is seeded with proposal cards directly (the
 * transcript IS the proposal store), then the route is exercised over
 * supertest: the newest card saves, older/unknown/saved cards refuse,
 * a canvas edit trips BASE_CHANGED, and a running turn answers 409.
 */
describe('POST /assistant/sessions/:id/save', () => {
  const TOKEN = 'aa10b-test-token';
  let baseDir: string;
  let staticDir: string;
  let sessionsDir: string;
  let repo: AgentRepo;
  let sessions: AuthorSessionStore;
  let app: ReturnType<typeof createApp>;

  const CARD_SPEC: AgentSpecV2 = {
    version: 2,
    name: 'Card bot',
    model: 'mock/mock-1',
    instructions: 'Be helpful.',
    triggers: [{ id: 't1', type: 'chat' }],
  };

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa10b-route-'));
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa10b-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html>');
    sessionsDir = path.join(baseDir, '.lousho', 'assistant', 'sessions');
    repo = new AgentRepo(baseDir);
    sessions = new AuthorSessionStore(sessionsDir);
    app = buildApp();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  function buildApp(runner?: AuthorTurnRunner): ReturnType<typeof createApp> {
    const agentStore = createFsAgentStore(baseDir, repo);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: (id) => repo.readSpec(id),
      saveSpec: (id, spec) => repo.writeSpec(id, spec),
    });
    return createApp({
      agentStore,
      runManager,
      baseDir,
      staticDir,
      access: { token: TOKEN },
      sessions,
      ...(runner !== undefined ? { authorRunner: runner } : {}),
    });
  }

  const authed = (r: request.Test) => r.set(STUDIO_TOKEN_HEADER, TOKEN);

  async function createSession(): Promise<AuthorSession> {
    const res = await authed(request(app).post('/assistant/sessions')).send({});
    expect(res.status).toBe(201);
    return res.body as AuthorSession;
  }

  function card(proposalId: string, over: Partial<ProposalOutput> = {}): ProposalOutput {
    return {
      ok: true,
      proposalId,
      kind: 'create',
      spec: CARD_SPEC,
      changes: [],
      requirements: [],
      carriedOver: false,
      carriedFields: [],
      baseSpecHash: null,
      enabled: false,
      ...over,
    };
  }

  function cardMessage(
    proposalId: string,
    name: 'proposeAgent' | 'proposeAgentUpdate',
    input: unknown,
    output: ProposalOutput
  ): AuthorAssistantMessage {
    return {
      id: `m_${proposalId}`,
      role: 'assistant',
      parts: [{ type: 'tool', toolCallId: proposalId, name, input, output, state: 'done' }],
      at: '2026-01-01T00:01:00.000Z',
    };
  }

  async function seed(sessionId: string, messages: AuthorMessage[]): Promise<void> {
    await sessions.update(sessionId, (s) => ({ ...s, transcript: [...s.transcript, ...messages] }));
  }

  function apply(sessionId: string, proposalId: unknown): request.Test {
    return authed(request(app).post(`/assistant/sessions/${sessionId}/save`)).send({ proposalId });
  }

  it('saves the newest card: 200, files written disabled, transcript ends with the uiEvent message', async () => {
    const session = await createSession();
    await seed(session.id, [
      { id: 'm_u1', role: 'user', text: 'build me a card bot', at: '2026-01-01T00:00:00.000Z' },
      cardMessage('call_p1', 'proposeAgent', { draft: {} }, card('call_p1')),
    ]);

    const res = await apply(session.id, 'call_p1');
    expect(res.status).toBe(200);
    const body = res.body as AuthorSaveResponse;
    expect(body).toMatchObject({ ok: true, agentId: 'card-bot', version: 1, name: 'Card bot', enabled: false });
    expect(body.message).toMatchObject({
      role: 'user',
      text: '',
      uiEvent: { kind: 'save', proposalId: 'call_p1', agentId: 'card-bot', version: 1 },
    });

    // The write: spec, disabled author-stamped meta, version 1.
    expect(await repo.readSpec('card-bot')).toEqual(CARD_SPEC);
    const meta = await repo.readMeta('card-bot');
    expect(meta.enabled).toBe(false);
    expect(meta.createdFrom).toEqual({ kind: 'author', ref: session.id });

    // The transcript's last message is the uiEvent the body echoed.
    const stored = await sessions.get(session.id);
    const last = stored?.transcript.at(-1) as AuthorUserMessage;
    expect(last).toMatchObject({
      role: 'user',
      text: '',
      uiEvent: { kind: 'save', proposalId: 'call_p1', agentId: 'card-bot', version: 1 },
    });
    expect(last.id).toBe(body.message.id);
    const version = JSON.parse(
      fs.readFileSync(path.join(baseDir, '.lousho', 'agents', 'card-bot', 'versions', '000001.json'), 'utf8')
    ) as { requestText: string | null; authorSessionId: string | null; source: string };
    expect(version).toMatchObject({
      source: 'author',
      requestText: 'build me a card bot',
      authorSessionId: session.id,
    });
  });

  it('a second Apply of the same card -> 400 ALREADY_SAVED', async () => {
    const session = await createSession();
    await seed(session.id, [cardMessage('call_p1', 'proposeAgent', { draft: {} }, card('call_p1'))]);
    expect((await apply(session.id, 'call_p1')).status).toBe(200);

    const res = await apply(session.id, 'call_p1');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'ALREADY_SAVED' });
  });

  it('Apply on an older card -> 400 STALE_PROPOSAL naming the newest card', async () => {
    const session = await createSession();
    await seed(session.id, [
      cardMessage('call_p1', 'proposeAgent', { draft: {} }, card('call_p1')),
      cardMessage('call_p2', 'proposeAgent', { draft: {} }, card('call_p2')),
    ]);
    const res = await apply(session.id, 'call_p1');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'STALE_PROPOSAL', details: { latestProposalId: 'call_p2' } });
    expect(repo.listIds()).toEqual([]);
  });

  it('an unknown proposalId -> 400 UNKNOWN_PROPOSAL', async () => {
    const session = await createSession();
    const res = await apply(session.id, 'call_nope');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'UNKNOWN_PROPOSAL' });
  });

  it('Apply on an update card after a canvas edit -> 400 BASE_CHANGED, nothing written', async () => {
    const saved: AgentSpecV2 = { ...CARD_SPEC, name: 'Triage' };
    await repo.writeSpec('triage', saved);
    await repo.writeMeta('triage', defaultMeta('2026-01-01T00:00:00.000Z'));
    const update = card('call_u1', {
      kind: 'update',
      agentId: 'triage',
      spec: { ...saved, description: 'Card description' },
      baseSpecHash: specHash(saved),
      enabled: true,
    });
    const session = await createSession();
    await seed(session.id, [
      cardMessage('call_u1', 'proposeAgentUpdate', { agentId: 'triage', patch: { description: 'Card description' } }, update),
    ]);
    // The canvas (or a hand edit) moved the spec after the card was shown.
    const onDisk: AgentSpecV2 = { ...saved, description: 'Canvas edit' };
    await repo.writeSpec('triage', onDisk);

    const res = await apply(session.id, 'call_u1');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'BASE_CHANGED' });
    expect(await repo.readSpec('triage')).toEqual(onDisk);
  });

  it('an update Apply writes the card spec as an author version', async () => {
    const saved: AgentSpecV2 = { ...CARD_SPEC, name: 'Triage' };
    await repo.writeSpec('triage', saved);
    await repo.writeMeta('triage', { ...defaultMeta('2026-01-01T00:00:00.000Z'), enabled: true });
    const update = card('call_u1', {
      kind: 'update',
      agentId: 'triage',
      spec: { ...saved, description: 'Card description' },
      baseSpecHash: specHash(saved),
      enabled: true,
    });
    const session = await createSession();
    await seed(session.id, [
      cardMessage('call_u1', 'proposeAgentUpdate', { agentId: 'triage', patch: {} }, update),
    ]);

    const res = await apply(session.id, 'call_u1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, agentId: 'triage', version: 1, enabled: true });
    expect((await repo.readSpec('triage'))?.description).toBe('Card description');
  });

  it('404 when the session does not exist', async () => {
    const res = await apply('as_0000000000000000', 'call_p1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Chat not found.', code: 'NOT_FOUND' });
  });

  it.each([{}, { proposalId: 5 }, { proposalId: '' }, { proposalId: 'x'.repeat(201) }, 'text'])(
    'a malformed body %j -> 400',
    async (body) => {
      const session = await createSession();
      const res = await authed(request(app).post(`/assistant/sessions/${session.id}/save`)).send(body as object);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_INPUT');
    }
  );

  it('409 BUSY while a reply is running in the chat', async () => {
    const runningRunner = { running: () => ({ requestId: 'req-live' }) } as unknown as AuthorTurnRunner;
    app = buildApp(runningRunner);
    const session = await createSession();
    await seed(session.id, [cardMessage('call_p1', 'proposeAgent', { draft: {} }, card('call_p1'))]);

    const res = await apply(session.id, 'call_p1');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'BUSY' });
    expect(repo.listIds()).toEqual([]);
  });

  it('a session whose workspace no longer resolves -> 400 AGENT_GONE', async () => {
    const session = await createSession();
    await seed(session.id, [cardMessage('call_p1', 'proposeAgent', { draft: {} }, card('call_p1'))]);
    await sessions.update(session.id, (s) => ({ ...s, workspaceId: 'ws-gone' }));

    const res = await apply(session.id, 'call_p1');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'AGENT_GONE' });
    expect(repo.listIds()).toEqual([]);
  });
});
