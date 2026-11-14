/**
 * T07: a run paused on `ask_question` shows `kind: 'question'` with the
 * question text/options and a deadline; `POST /agents/:id/approve` with
 * `{ answer }` resumes it (the first answer wins, a second is a 409); an
 * unanswered pause resolves itself at its deadline - a question as
 * NO_ANSWER_TEXT, a tool approval denied with EXPIRED_APPROVAL_NOTE - and
 * `approved`/`answer` sent to the wrong kind of pause is a 400
 * `LOUSHO_APPROVAL_KIND`.
 *
 * The model is a `mockModel` script registered under the test-only
 * provider name 'qtest' (`LLMProviderRegistry.register`); the factory
 * returns the same instance across the host's rebuild on resume, so the
 * script continues where the paused run left off.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import request from 'supertest';
import { LLMProviderRegistry, type AgentSpecV2 } from '@linuxdevil/lousho';
import { mockModel, type MockTurn } from '@linuxdevil/lousho/testing';
import type { LogEntry } from '../../shared/wireTypes';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { AgentRepo } from '../storage/agentRepo';
import { EXPIRED_APPROVAL_NOTE, NO_ANSWER_TEXT } from '../approvalDeadline';

const asking = (args: Record<string, unknown>): MockTurn => ({ toolCalls: [{ name: 'ask_question', args, id: 'call_q' }] });
const whichCity = asking({ question: 'Which city?', options: ['Porto', 'Lisbon'] });
const callDemo = { toolCalls: [{ name: 'demo-approval', args: {}, id: 'call_d' }] } satisfies MockTurn;

const QUESTION_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'question-agent',
  model: 'qtest/m1',
  instructions: 'You are a helpful agent.',
  askQuestion: true,
};

const GATED_SPEC: AgentSpecV2 = {
  version: 2,
  name: 'gated-agent',
  model: 'qtest/m1',
  instructions: 'You are a helpful agent.',
  tools: [{ registry: 'demo-approval' }],
};

let model: ReturnType<typeof mockModel>;

// The host resolves the provider on every build (start AND resume); the
// same scripted instance must answer both times or the resumed run would
// replay the pausing turn.
LLMProviderRegistry.register('qtest', () => model);

/** The last tool-result message's parsed JSON content from a settled status payload's `result.messages`. */
function toolResultOf(status: { result?: unknown }): unknown {
  const messages = (status.result as { messages?: { role: string; content?: string }[] } | undefined)?.messages ?? [];
  const tool = [...messages].reverse().find((m) => m.role === 'tool');
  return tool?.content === undefined ? undefined : JSON.parse(tool.content);
}

/** The last tool-result message's raw string content. */
function toolResultTextOf(status: { result?: unknown }): string {
  const messages = (status.result as { messages?: { role: string; content?: string }[] } | undefined)?.messages ?? [];
  const tool = [...messages].reverse().find((m) => m.role === 'tool');
  return tool?.content ?? '';
}

function waitForStatus(
  runManager: RunManager,
  agentId: string,
  predicate: (status: { status: string }) => boolean,
  timeoutMs = 3000
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const current = runManager.status(agentId);
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runManager.off('status', onStatus);
      reject(new Error('Timed out waiting for status'));
    }, timeoutMs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

describe('questions and approvals in the test pane', () => {
  let baseDir: string;
  let runManager: RunManager;
  let app: ReturnType<typeof createApp>;
  let logs: LogEntry[];

  function makeRunManager(minDeadlineMs?: number) {
    return new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: async () => undefined,
      saveSpec: async () => {},
      ...(minDeadlineMs !== undefined && { minDeadlineMs }),
    });
  }

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-n-questions-test-'));
    logs = [];
    runManager = makeRunManager();
    runManager.on('log', (_agentId: string, entry: LogEntry) => logs.push(entry));
    const repo = new AgentRepo(baseDir);
    app = createApp({ agentStore: createFsAgentStore(baseDir, repo), runManager, baseDir });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('pauses with kind question, the question/options and a deadline', async () => {
    model = mockModel([whichCity, 'Lisbon it is.']);
    await runManager.run('q-1', 'Book a trip', QUESTION_SPEC);
    const paused = await waitForStatus(runManager, 'q-1', (s) => s.status === 'paused');

    const pending = paused.pendingApproval;
    expect(pending.kind).toBe('question');
    expect(pending.question).toEqual({ text: 'Which city?', options: ['Porto', 'Lisbon'] });
    const ms = Date.parse(pending.deadline) - Date.now();
    expect(ms).toBeGreaterThan(14 * 60_000);
    expect(ms).toBeLessThanOrEqual(15 * 60_000 + 1_000);
  });

  it('POST /approve with an answer resumes the run; the tool result carries the answer', async () => {
    model = mockModel([whichCity, 'Lisbon it is.']);
    await runManager.run('q-2', 'Book a trip', QUESTION_SPEC);
    const paused = await waitForStatus(runManager, 'q-2', (s) => s.status === 'paused');

    const res = await request(app)
      .post('/agents/q-2/approve')
      .send({ approvalId: paused.pendingApproval.approvalId, answer: 'Lisbon' });
    expect(res.status).toBe(202);

    const done = await waitForStatus(runManager, 'q-2', (s) => s.status === 'done');
    expect(done.resultText).toBe('Lisbon it is.');
    // The ask_question tool result the model answered from carries the reply.
    expect(toolResultOf(done)).toMatchObject({ answer: 'Lisbon' });
  });

  it('the first answer wins: a second answer for the same pause is a 409', async () => {
    model = mockModel([whichCity, 'Lisbon it is.']);
    await runManager.run('q-3', 'Book a trip', QUESTION_SPEC);
    const paused = await waitForStatus(runManager, 'q-3', (s) => s.status === 'paused');
    const { approvalId } = paused.pendingApproval;

    const first = await request(app).post('/agents/q-3/approve').send({ approvalId, answer: 'Lisbon' });
    expect(first.status).toBe(202);
    await waitForStatus(runManager, 'q-3', (s) => s.status === 'done');

    const second = await request(app).post('/agents/q-3/approve').send({ approvalId, answer: 'Porto' });
    expect(second.status).toBe(409);
    await expect(runManager.answer('q-3', approvalId, 'Porto')).rejects.toThrow(/no pending/i);
  });

  it('an unanswered question resolves itself at the deadline with the no-answer text and a warn log', async () => {
    runManager = makeRunManager(50);
    runManager.on('log', (_agentId: string, entry: LogEntry) => logs.push(entry));
    app = createApp({ agentStore: createFsAgentStore(baseDir, new AgentRepo(baseDir)), runManager, baseDir });
    model = mockModel([whichCity, 'Carrying on.']);

    await runManager.run('q-4', 'Book a trip', QUESTION_SPEC);
    await waitForStatus(runManager, 'q-4', (s) => s.status === 'paused');
    const done = await waitForStatus(runManager, 'q-4', (s) => s.status === 'done');

    expect(done.resultText).toBe('Carrying on.');
    expect(toolResultOf(done)).toMatchObject({ answer: NO_ANSWER_TEXT });
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('Nobody answered before the deadline'))).toBe(true);
  });

  it('an undecided tool approval resolves itself at the deadline as a denial with the expired note', async () => {
    runManager = makeRunManager(50);
    runManager.on('log', (_agentId: string, entry: LogEntry) => logs.push(entry));
    app = createApp({ agentStore: createFsAgentStore(baseDir, new AgentRepo(baseDir)), runManager, baseDir });
    model = mockModel([callDemo, 'Moving on without it.']);

    await runManager.run('t-5', 'Call the tool', GATED_SPEC);
    const paused = await waitForStatus(runManager, 't-5', (s) => s.status === 'paused');
    expect(paused.pendingApproval.kind).toBe('tool');
    const done = await waitForStatus(runManager, 't-5', (s) => s.status === 'done');

    expect(done.resultText).toBe('Moving on without it.');
    expect(toolResultTextOf(done)).toContain(EXPIRED_APPROVAL_NOTE);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('Nobody answered before the deadline'))).toBe(true);
  });

  it('approved sent to a question pause is a 400 LOUSHO_APPROVAL_KIND', async () => {
    model = mockModel([whichCity, 'Lisbon it is.']);
    await runManager.run('q-6', 'Book a trip', QUESTION_SPEC);
    const paused = await waitForStatus(runManager, 'q-6', (s) => s.status === 'paused');

    const res = await request(app)
      .post('/agents/q-6/approve')
      .send({ approvalId: paused.pendingApproval.approvalId, approved: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_APPROVAL_KIND');

    // Clean up so the pause does not outlive the test.
    await runManager.answer('q-6', paused.pendingApproval.approvalId, 'Lisbon');
    await waitForStatus(runManager, 'q-6', (s) => s.status === 'done');
  });

  it('answer sent to a tool approval is a 400 LOUSHO_APPROVAL_KIND', async () => {
    model = mockModel([callDemo, 'Done.']);
    await runManager.run('t-7', 'Call the tool', GATED_SPEC);
    const paused = await waitForStatus(runManager, 't-7', (s) => s.status === 'paused');

    const res = await request(app)
      .post('/agents/t-7/approve')
      .send({ approvalId: paused.pendingApproval.approvalId, answer: 'go ahead' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOUSHO_APPROVAL_KIND');

    // The real decision still works afterwards.
    const ok = await request(app)
      .post('/agents/t-7/approve')
      .send({ approvalId: paused.pendingApproval.approvalId, approved: true });
    expect(ok.status).toBe(202);
    await waitForStatus(runManager, 't-7', (s) => s.status === 'done');
  });

  it('an answer outside 1..4000 characters is a 400', async () => {
    model = mockModel([whichCity, 'Lisbon it is.']);
    await runManager.run('q-8', 'Book a trip', QUESTION_SPEC);
    const paused = await waitForStatus(runManager, 'q-8', (s) => s.status === 'paused');
    const { approvalId } = paused.pendingApproval;

    for (const answer of ['', 'x'.repeat(4001)]) {
      const res = await request(app).post('/agents/q-8/approve').send({ approvalId, answer });
      expect(res.status).toBe(400);
    }

    await runManager.answer('q-8', approvalId, 'Lisbon');
    await waitForStatus(runManager, 'q-8', (s) => s.status === 'done');
  });
});
