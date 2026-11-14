import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { mockModel } from '@linuxdevil/lousho/testing';
import { createApp } from '../app';
import { STUDIO_TOKEN_HEADER } from '../auth';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { AuthorSessionStore } from '../author/sessionStore';
import { AuthorTurnRunner } from '../author/turnRunner';
import { requestSecretTool } from '../author/tools/requestSecretTool';
import type { AuthorToolDeps } from '../author/tools/index';
import { SettingsStore } from '../settingsStore';
import { SecretsStore } from '../secretsStore';
import type {
  AuthorAssistantMessage,
  AuthorServerEvent,
  AuthorSession,
  AuthorUserMessage,
} from '../../shared/authorWire';

/**
 * `POST /assistant/sessions/:id/secret` (AA14): the SecretCard's answer.
 * A turn that calls requestSecret ends with the part `state:'pending'`
 * and a `tool.pending` event; the POST writes the value to the encrypted
 * secrets store only, settles the part, appends the `uiEvent` user
 * message and starts a continuation turn whose model input contains the
 * `[UI event]` outcome text - never the value.
 */
describe('POST /assistant/sessions/:id/secret', () => {
  const TOKEN = 'aa14-test-token';
  const VALUE = 'sk-test-VALUE-123';
  const REQUEST_ID = 'req-aa14-00001';
  let baseDir: string;
  let staticDir: string;
  let sessionsDir: string;
  let repo: AgentRepo;
  let sessions: AuthorSessionStore;
  let secrets: SecretsStore;
  let settings: SettingsStore;

  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'] as const;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa14-route-'));
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-aa14-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html>');
    sessionsDir = path.join(baseDir, '.lousho', 'assistant', 'sessions');
    repo = new AgentRepo(baseDir);
    sessions = new AuthorSessionStore(sessionsDir);
    secrets = new SecretsStore(baseDir);
    settings = new SettingsStore(baseDir);
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  function buildApp(runner: AuthorTurnRunner | Pick<AuthorTurnRunner, 'running' | 'continueAfterUiEvent'>) {
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
      secretsStore: secrets,
      settingsStore: settings,
      authorRunner: runner as AuthorTurnRunner,
    });
  }

  const authed = (r: request.Test) => r.set(STUDIO_TOKEN_HEADER, TOKEN);

  async function createSession(app: ReturnType<typeof createApp>): Promise<AuthorSession> {
    const res = await authed(request(app).post('/assistant/sessions')).send({});
    expect(res.status).toBe(201);
    return res.body as AuthorSession;
  }

  interface Collected {
    events: AuthorServerEvent[];
    waitFor: (pred: (e: AuthorServerEvent) => boolean) => Promise<AuthorServerEvent>;
  }

  /** The session's events plus a backlog-aware waiter (the continuation turn's requestId is server-made). */
  function collect(runner: AuthorTurnRunner, sessionId: string): Collected {
    const events: AuthorServerEvent[] = [];
    const waiters: { pred: (e: AuthorServerEvent) => boolean; resolve: (e: AuthorServerEvent) => void }[] = [];
    runner.on('event', (sid: string, ev: AuthorServerEvent) => {
      if (sid !== sessionId) return;
      events.push(ev);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].pred(ev)) waiters.splice(i, 1)[0].resolve(ev);
      }
    });
    return {
      events,
      waitFor: (pred) =>
        new Promise<AuthorServerEvent>((resolve) => {
          const hit = events.find(pred);
          if (hit !== undefined) resolve(hit);
          else waiters.push({ pred, resolve });
        }),
    };
  }

  /**
   * A real runner whose one tool is the real `requestSecret`: `script`
   * scripts the model across the asking turn AND the continuation turn.
   */
  function setup(script: Parameters<typeof mockModel>[0]) {
    const model = mockModel(script);
    const toolDeps = { secrets } as unknown as AuthorToolDeps;
    const runner = new AuthorTurnRunner({
      sessions,
      settings,
      secrets,
      systemPrompt: () => 'You are the lousho Agent Author.',
      buildTools: (turn) => [requestSecretTool(turn, toolDeps)],
      turnContextInput: async (s, now) => ({ focus: s.focus, openProposals: [], now }),
      providerFor: () => model,
    });
    return { model, runner };
  }

  /** Runs the asking turn to completion: requestSecret called as `call_s1`, then one text line. */
  async function pendingCard(scriptTail: Parameters<typeof mockModel>[0]) {
    const { model, runner } = setup([
      { toolCalls: [{ name: 'requestSecret', args: { name: 'MY_TOKEN', why: 'The agent needs it.' }, id: 'call_s1' }] },
      'Please fill in the card.',
      ...scriptTail,
    ]);
    const app = buildApp(runner);
    const session = await createSession(app);
    const collected = collect(runner, session.id);
    const started = await runner.start(session.id, { requestId: REQUEST_ID, text: 'set it up' });
    expect(started).toEqual({ ok: true, requestId: REQUEST_ID });
    await collected.waitFor((e) => e.type === 'turn.finished' && e.requestId === REQUEST_ID);
    return { model, runner, app, session, collected };
  }

  function secretPost(app: ReturnType<typeof createApp>, sessionId: string, body: unknown): request.Test {
    return authed(request(app).post(`/assistant/sessions/${sessionId}/secret`)).send(body as object);
  }

  /** Waits for the server-made continuation turn to start and finish; returns its requestId. */
  async function awaitContinuation(collected: Collected): Promise<string> {
    const started = await collected.waitFor((e) => e.type === 'turn.started' && e.requestId !== REQUEST_ID);
    await collected.waitFor(
      (e) => (e.type === 'turn.finished' || e.type === 'turn.error') && e.requestId === started.requestId
    );
    return started.requestId;
  }

  function toolPart(session: AuthorSession | undefined, toolCallId: string) {
    const assistant = session?.transcript.find(
      (m): m is AuthorAssistantMessage =>
        m.role === 'assistant' && m.parts.some((p) => p.type === 'tool' && p.toolCallId === toolCallId)
    );
    return assistant?.parts.find((p) => p.type === 'tool' && p.toolCallId === toolCallId);
  }

  /** Every text the model ever saw (every call's every message) as one searchable blob. */
  function modelSawAll(model: ReturnType<typeof mockModel>): string {
    return model.calls.map((c) => JSON.stringify(c.messages)).join('\n');
  }

  it('a turn calling requestSecret ends with the part pending and a tool.pending event', async () => {
    const { session, collected } = await pendingCard(['Done.']);

    expect(collected.events).toContainEqual(
      expect.objectContaining({ type: 'tool.call', toolCallId: 'call_s1', name: 'requestSecret' })
    );
    expect(collected.events).toContainEqual(
      expect.objectContaining({ type: 'tool.pending', toolCallId: 'call_s1', name: 'requestSecret' })
    );
    expect(collected.events.some((e) => e.type === 'tool.result' && e.toolCallId === 'call_s1')).toBe(false);
    const part = toolPart(await sessions.get(session.id), 'call_s1');
    expect(part).toMatchObject({ type: 'tool', state: 'pending' });
  });

  it('POST with a value: 204, secret stored, value nowhere in the transcript or the model input', async () => {
    const { model, app, session, collected } = await pendingCard(['All set.']);

    const res = await secretPost(app, session.id, { toolCallId: 'call_s1', name: 'MY_TOKEN', value: VALUE });
    expect(res.status).toBe(204);

    // The value is in the encrypted store - readable through D13's path only.
    expect(secrets.getSecret('MY_TOKEN')).toBe(VALUE);

    const continuationId = await awaitContinuation(collected);
    expect(continuationId).not.toBe(REQUEST_ID);

    // The settled part + the appended uiEvent message.
    const stored = await sessions.get(session.id);
    const part = toolPart(stored, 'call_s1');
    expect(part).toMatchObject({ state: 'done', output: { ok: true, name: 'MY_TOKEN', status: 'saved' } });
    const last = stored?.transcript.at(-2) as AuthorUserMessage; // uiEvent message, then the continuation's assistant reply
    expect(last).toMatchObject({
      role: 'user',
      text: '',
      uiEvent: { kind: 'secret', toolCallId: 'call_s1', name: 'MY_TOKEN', outcome: 'saved' },
    });
    expect(stored?.transcript.at(-1)).toMatchObject({ role: 'assistant' });

    // The value reached neither the session file nor any model input; the
    // [UI event] outcome text did reach the continuation call.
    const fileText = fs.readFileSync(path.join(sessionsDir, `${session.id}.json`), 'utf8');
    expect(fileText).not.toContain(VALUE);
    expect(modelSawAll(model)).not.toContain(VALUE);
    const lastCall = model.calls.at(-1)!;
    const userTexts = lastCall.messages.filter((m) => m.role === 'user').map((m) => String(m.content));
    expect(userTexts.some((t) => t.includes('[UI event] The user saved the secret MY_TOKEN'))).toBe(true);
  });

  it('POST declined: 204, DECLINED output stored, continuation turn runs', async () => {
    const { model, app, session, collected } = await pendingCard(['Carried on.']);

    const res = await secretPost(app, session.id, { toolCallId: 'call_s1', name: 'MY_TOKEN', declined: true });
    expect(res.status).toBe(204);
    expect(secrets.getSecret('MY_TOKEN')).toBeUndefined();

    await awaitContinuation(collected);
    const stored = await sessions.get(session.id);
    const part = toolPart(stored, 'call_s1');
    expect(part).toMatchObject({
      state: 'done',
      output: {
        ok: false,
        code: 'DECLINED',
        name: 'MY_TOKEN',
        error: 'The user chose not to enter MY_TOKEN now.',
        userMessage: 'Skipped for now.',
      },
    });
    expect(stored?.transcript.at(-2)).toMatchObject({
      uiEvent: { kind: 'secret', toolCallId: 'call_s1', name: 'MY_TOKEN', outcome: 'declined' },
    });
    const lastCall = model.calls.at(-1)!;
    const userTexts = lastCall.messages.filter((m) => m.role === 'user').map((m) => String(m.content));
    expect(userTexts.some((t) => t.includes('[UI event] The user skipped entering the secret MY_TOKEN'))).toBe(true);
  });

  it('a second POST for the same toolCallId -> 404 NOT_PENDING', async () => {
    const { app, session, collected } = await pendingCard(['All set.']);

    expect((await secretPost(app, session.id, { toolCallId: 'call_s1', name: 'MY_TOKEN', value: VALUE })).status).toBe(204);
    await awaitContinuation(collected);

    const res = await secretPost(app, session.id, { toolCallId: 'call_s1', name: 'MY_TOKEN', value: 'sk-test-OTHER' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'This request is no longer waiting for a value.', code: 'NOT_PENDING' });
    // The losing answer never overwrote the stored value.
    expect(secrets.getSecret('MY_TOKEN')).toBe(VALUE);
  });

  it('a name that does not match the card -> 400, and the card stays pending', async () => {
    const { app, session } = await pendingCard(['All set.']);

    const res = await secretPost(app, session.id, { toolCallId: 'call_s1', name: 'OTHER_TOKEN', value: VALUE });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'The secret name does not match the request.', code: 'INVALID_INPUT' });
    expect(secrets.getSecret('OTHER_TOKEN')).toBeUndefined();
    const part = toolPart(await sessions.get(session.id), 'call_s1');
    expect(part).toMatchObject({ state: 'pending' });
  });

  it.each([
    ['neither value nor declined', { toolCallId: 'call_s1', name: 'MY_TOKEN' }],
    ['both value and declined', { toolCallId: 'call_s1', name: 'MY_TOKEN', value: 'x', declined: true }],
    ['an empty value', { toolCallId: 'call_s1', name: 'MY_TOKEN', value: '' }],
    ['a whitespace-only value', { toolCallId: 'call_s1', name: 'MY_TOKEN', value: '   ' }],
    ['an overlong value', { toolCallId: 'call_s1', name: 'MY_TOKEN', value: 'v'.repeat(8193) }],
    ['declined not true', { toolCallId: 'call_s1', name: 'MY_TOKEN', declined: false }],
  ])('an invalid answer (%s) -> 400', async (_label, body) => {
    const { app, session } = await pendingCard(['All set.']);

    const res = await secretPost(app, session.id, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Enter a value, or skip.', code: 'INVALID_INPUT' });
    const part = toolPart(await sessions.get(session.id), 'call_s1');
    expect(part).toMatchObject({ state: 'pending' });
  });

  it('an unknown session -> 404', async () => {
    const { app } = await pendingCard(['All set.']);
    const res = await secretPost(app, 'as_0000000000000000', { toolCallId: 'call_s1', name: 'MY_TOKEN', value: VALUE });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Chat not found.', code: 'NOT_FOUND' });
  });

  it('an unknown toolCallId -> 404 NOT_PENDING', async () => {
    const { app, session } = await pendingCard(['All set.']);
    const res = await secretPost(app, session.id, { toolCallId: 'call_nope', name: 'MY_TOKEN', value: VALUE });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'This request is no longer waiting for a value.', code: 'NOT_PENDING' });
  });

  it('409 BUSY while a reply is running in the chat', async () => {
    const runningRunner = {
      running: () => ({ requestId: 'req-live' }),
      continueAfterUiEvent: async () => ({ ok: true as const, requestId: 'req-live' }),
    };
    const app = buildApp(runningRunner);
    const session = await createSession(app);
    const res = await secretPost(app, session.id, { toolCallId: 'call_s1', name: 'MY_TOKEN', value: VALUE });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Wait for the Author to finish replying, then try again.',
      code: 'BUSY',
    });
  });

  it('requestSecret on an already-stored name answers exists - no pending part, tool.result instead', async () => {
    secrets.setSecret('MY_TOKEN', 'sk-old-1');
    const { model, runner } = setup([
      { toolCalls: [{ name: 'requestSecret', args: { name: 'MY_TOKEN', why: 'needed' }, id: 'call_s1' }] },
      'Already stored.',
    ]);
    const app = buildApp(runner);
    const session = await createSession(app);
    const collected = collect(runner, session.id);
    await runner.start(session.id, { requestId: REQUEST_ID, text: 'ask anyway' });
    await collected.waitFor((e) => e.type === 'turn.finished' && e.requestId === REQUEST_ID);

    expect(collected.events).toContainEqual(
      expect.objectContaining({
        type: 'tool.result',
        toolCallId: 'call_s1',
        name: 'requestSecret',
        output: { ok: true, name: 'MY_TOKEN', status: 'exists' },
      })
    );
    expect(collected.events.some((e) => e.type === 'tool.pending')).toBe(false);
    const part = toolPart(await sessions.get(session.id), 'call_s1');
    expect(part).toMatchObject({ state: 'done', output: { ok: true, name: 'MY_TOKEN', status: 'exists' } });
    // No pending card means the POST has nothing to answer.
    const res = await secretPost(app, session.id, { toolCallId: 'call_s1', name: 'MY_TOKEN', value: VALUE });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_PENDING');
    expect(modelSawAll(model)).not.toContain('sk-old-1');
  });
});
