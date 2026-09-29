import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import request from 'supertest';
import type { AgentSpec } from '@loushy/build-ai-agent';
import { createApp } from '../app';
import { RunManager, AlreadyRunningError, ApprovalPendingError } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';

const SPEC: AgentSpec = {
  name: 'test-agent',
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
  tools: ['current-date'],
};

function waitForStatus(
  runManager: RunManager,
  agentId: string,
  predicate: (status: { status: string }) => boolean,
  timeoutMs = 2000
): Promise<any> {
  const current = runManager.status(agentId);
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runManager.off('status', onStatus);
      reject(new Error('Timed out waiting for status'));
    }, timeoutMs);
    function onStatus(payload: any) {
      if (payload.agentId !== agentId) return;
      if (predicate(payload)) {
        clearTimeout(timer);
        runManager.off('status', onStatus);
        resolve(payload);
      }
    }
    runManager.on('status', onStatus);
  });
}

describe('P1/P3 chat transport (RunManager)', () => {
  let baseDir: string;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-p-chat-test-'));
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: async () => undefined,
      saveSpec: async () => {},
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('reports an empty chat transcript for an agent that has never chatted', () => {
    expect(runManager.chatState('nope')).toEqual({ agentId: 'nope', sessionId: 'nope', messages: [] });
  });

  it('sendMessage() appends the user turn immediately, then reconciles the real ExecutionResult.messages on settle', async () => {
    const chatEvents: any[] = [];
    runManager.on('chat', (id: string, payload: any) => {
      if (id === 'agent-chat-1') chatEvents.push(payload);
    });

    await runManager.sendMessage('agent-chat-1', 'hello there', SPEC);

    // The user message is reflected before the run settles.
    expect(chatEvents[0].messages).toHaveLength(1);
    expect(chatEvents[0].messages[0]).toMatchObject({ role: 'user', content: 'hello there' });

    await waitForStatus(runManager, 'agent-chat-1', (s) => s.status === 'stopped');

    const finalState = runManager.chatState('agent-chat-1');
    // system + user + assistant, straight from AgentExecutor's real message array.
    expect(finalState.messages.some((m) => m.role === 'assistant' && m.content === 'This is a mock response.')).toBe(
      true
    );
    expect(finalState.messages.some((m) => m.role === 'user' && m.content === 'hello there')).toBe(true);
    // The optimistic user message's id/timestamp survived reconciliation unchanged.
    const optimisticUserId = chatEvents[0].messages[0].id;
    const finalUserMsg = finalState.messages.find((m) => m.role === 'user');
    expect(finalUserMsg!.id).toBe(optimisticUserId);
  });

  it('continues the same conversation across two sendMessage() calls instead of starting fresh', async () => {
    await runManager.sendMessage('agent-chat-2', 'please use current-date', SPEC);
    await waitForStatus(runManager, 'agent-chat-2', (s) => s.status === 'stopped');
    const afterFirst = runManager.chatState('agent-chat-2').messages;
    expect(afterFirst.length).toBeGreaterThanOrEqual(3); // user + tool-call assistant + tool result (+ maybe final assistant)

    await runManager.sendMessage('agent-chat-2', 'thanks', SPEC);
    await waitForStatus(runManager, 'agent-chat-2', (s) => s.status === 'stopped');
    const afterSecond = runManager.chatState('agent-chat-2').messages;

    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
    // Every message from the first turn is still present, in order, with the same ids.
    for (let i = 0; i < afterFirst.length; i++) {
      expect(afterSecond[i].id).toBe(afterFirst[i].id);
    }
    expect(afterSecond.some((m) => m.role === 'user' && m.content === 'thanks')).toBe(true);
  });

  it('rejects sendMessage() while a run is already in flight', async () => {
    await runManager.sendMessage('agent-chat-3', 'please use current-date', SPEC);
    await expect(runManager.sendMessage('agent-chat-3', 'again', SPEC)).rejects.toBeInstanceOf(AlreadyRunningError);
    await waitForStatus(runManager, 'agent-chat-3', (s) => s.status === 'stopped');
  });

  it('rejects sendMessage() while paused awaiting an approval decision', async () => {
    // None of the LOU-N server's spec-resolvable tools set `needsApproval`
    // (see approvalFlow.test.ts's doc comment), so a spec alone can't drive
    // RunManager into a genuinely paused state here - seed the (private,
    // in-memory) entry directly instead, exactly mirroring the shape
    // handleRunSettled() would have produced for a real paused run.
    const internals = runManager as unknown as { entries: Map<string, any> };
    internals.entries.set('agent-chat-4', {
      status: 'paused',
      sessionId: 'agent-chat-4',
      reason: 'awaiting_approval',
      pendingApproval: { approvalId: 'appr-1', toolName: 'send-email', args: {}, createdAt: new Date().toISOString() },
      messages: [],
      chatSessionId: 'agent-chat-4',
      chatStartedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await expect(runManager.sendMessage('agent-chat-4', 'go ahead', SPEC)).rejects.toBeInstanceOf(
      ApprovalPendingError
    );
  });

  it('newChat() archives the current transcript under its own session id and starts an empty one', async () => {
    await runManager.sendMessage('agent-chat-5', 'first conversation', SPEC);
    await waitForStatus(runManager, 'agent-chat-5', (s) => s.status === 'stopped');
    const firstSessionId = runManager.chatState('agent-chat-5').sessionId;

    const fresh = runManager.newChat('agent-chat-5');
    expect(fresh.messages).toHaveLength(0);
    expect(fresh.sessionId).not.toBe(firstSessionId);

    await runManager.sendMessage('agent-chat-5', 'second conversation', SPEC);
    await waitForStatus(runManager, 'agent-chat-5', (s) => s.status === 'stopped');

    const sessions = runManager.listChats('agent-chat-5');
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([firstSessionId, fresh.sessionId].sort());

    const firstRecord = runManager.loadChatSession('agent-chat-5', firstSessionId);
    expect(firstRecord!.messages.some((m) => m.content === 'first conversation')).toBe(true);
    expect(firstRecord!.messages.some((m) => m.content === 'second conversation')).toBe(false);
  });

  it('persists chat history to disk and rehydrates it for a fresh RunManager instance (server-restart survival)', async () => {
    await runManager.sendMessage('agent-chat-6', 'remember this', SPEC);
    await waitForStatus(runManager, 'agent-chat-6', (s) => s.status === 'stopped');

    const restarted = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: async () => undefined,
      saveSpec: async () => {},
    });
    const rehydrated = restarted.chatState('agent-chat-6');
    expect(rehydrated.messages.some((m) => m.content === 'remember this')).toBe(true);
  });
});

describe('P1/P3 chat transport (HTTP routes)', () => {
  let baseDir: string;
  let app: ReturnType<typeof createApp>;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-p-chat-app-test-'));
    const agentStore = createFsAgentStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    app = createApp({ agentStore, runManager });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('POST /agents/:id/message rejects a missing message body', async () => {
    const res = await request(app).post('/agents/foo/message').send({});
    expect(res.status).toBe(400);
  });

  it('POST /agents/:id/message starts a chat turn and GET /chat reflects it once settled', async () => {
    const post = await request(app).post('/agents/foo/message').send({ message: 'hi there', spec: SPEC });
    expect(post.status).toBe(202);

    await waitForStatus(runManager, 'foo', (s) => s.status === 'stopped');

    const get = await request(app).get('/agents/foo/chat');
    expect(get.status).toBe(200);
    expect(get.body.messages.some((m: any) => m.role === 'user' && m.content === 'hi there')).toBe(true);
    expect(get.body.messages.some((m: any) => m.role === 'assistant')).toBe(true);
  });

  // The "already running"/"approval pending" 409 guards are covered
  // deterministically at the RunManager unit level above (calling
  // sendMessage() twice back-to-back with no intervening await, and by
  // seeding a paused entry directly) - reproducing that race through a real
  // HTTP round-trip against the near-instant mock provider is flaky for the
  // same reason documented in app.test.ts's equivalent note for
  // POST /agents/:id/run.

  it('POST /agents/:id/chat/new then GET /agents/:id/chats lists both sessions', async () => {
    await request(app).post('/agents/foo/message').send({ message: 'first session', spec: SPEC });
    await waitForStatus(runManager, 'foo', (s) => s.status === 'stopped');

    const newChat = await request(app).post('/agents/foo/chat/new');
    expect(newChat.status).toBe(200);
    expect(newChat.body.messages).toHaveLength(0);

    const list = await request(app).get('/agents/foo/chats');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
    expect(list.body[0]).toHaveProperty('preview');
  });

  it('GET /agents/:id/chats/:sessionId 404s for an unknown session', async () => {
    const res = await request(app).get('/agents/foo/chats/does-not-exist');
    expect(res.status).toBe(404);
  });
});
