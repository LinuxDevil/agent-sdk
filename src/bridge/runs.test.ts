/**
 * W10b acceptance tests: `run`/`chat`/`steer`/`abort`/`resolveApproval`/
 * `answerQuestion` over `serveBridge`, with pushed `agent`/`span.*`/
 * `steer.joined`/`run.settled`/`run.failed` events. The `mock` provider is
 * a scripted {@link mockModel} registered on `LLMProviderRegistry` so
 * `model: 'mock/…'` specs reach it.
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { LLMProviderRegistry } from '../providers/llm';
import { textOf } from '../providers/content';
import type { Message } from '../providers/llm';
import { mockModel, type MockModel } from '../testing';
import type { AgentSpecV2 } from '../spec/v2/types';
import type { BridgePush, BridgeResponse } from './protocol';
import { serveBridge, type BridgeIo } from './server';

let model: MockModel;

beforeEach(() => {
  model = mockModel(['unused']);
  LLMProviderRegistry.register('mock', () => model);
});

interface TestBridge {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  root: string;
  done: Promise<number>;
  send(method: string, params?: unknown, id?: number): number;
  response(id: number): Promise<BridgeResponse>;
  /** Every parsed stdout line so far (responses and pushes), in order. */
  lines(): Array<Record<string, unknown>>;
  /** Pushes for `runId` seen so far. */
  pushes(runId: string): BridgePush[];
  /** Polls `predicate` against the parsed lines until it holds (5 s cap). */
  waitFor(predicate: (lines: Array<Record<string, unknown>>) => boolean, what: string): Promise<void>;
}

/** A `serveBridge` session over PassThrough streams; `root` is a fresh temp project dir. */
function bridge(): TestBridge {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const root = mkdtempSync(path.join(tmpdir(), 'lousho-bridge-runs-'));
  const pending: { id: number | null; resolve: (r: BridgeResponse) => void; reject: (e: Error) => void }[] = [];
  const seen: Array<Record<string, unknown>> = [];
  let buffer = '';
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      seen.push(parsed);
      const waiter = pending.find((w) => w.id === parsed.id);
      if (waiter !== undefined) {
        pending.splice(pending.indexOf(waiter), 1);
        waiter.resolve(parsed as BridgeResponse);
      }
    }
  });
  let nextId = 1;
  const io: Required<BridgeIo> = { stdin, stdout, stderr, root };
  const done = serveBridge(io);
  const parsed = () => seen;
  return {
    stdin,
    stdout,
    stderr,
    root,
    done,
    send(method, params, id) {
      const rid = id ?? nextId++;
      stdin.write(`${JSON.stringify({ id: rid, method, params })}\n`);
      return rid;
    },
    response(id) {
      return new Promise<BridgeResponse>((resolve, reject) => {
        const existing = seen.find((m) => 'id' in m && m.id === id) as BridgeResponse | undefined;
        if (existing !== undefined) return resolve(existing);
        pending.push({ id, resolve, reject });
        setTimeout(() => reject(new Error(`no response for id ${id}; saw ${JSON.stringify(seen)}`)), 8000);
      });
    },
    lines: parsed,
    pushes: (runId) => seen.filter((m) => m.event !== undefined && m.runId === runId) as unknown as BridgePush[],
    async waitFor(predicate, what) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (predicate(parsed())) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${what}; saw ${JSON.stringify(seen)}`);
    },
  };
}

const result = (r: BridgeResponse) => ('result' in r ? r.result : undefined);
const error = (r: BridgeResponse) => ('error' in r ? r.error : undefined);

const SPEC: AgentSpecV2 = { version: 2, name: 'a', model: 'mock/m', instructions: 'Be brief.' };

function runParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { agentId: 'agent1', spec: SPEC, sessionId: 's1', input: 'hello', ...overrides };
}

async function hello(b: TestBridge): Promise<void> {
  const r = await b.response(b.send('hello', { protocol: 1, client: { name: 'test', version: '0' } }));
  expect(error(r)).toBeUndefined();
}

/** Starts a run and returns its runId once the `run` response lands. */
async function startRun(b: TestBridge, params: Record<string, unknown> = runParams()): Promise<string> {
  const r = await b.response(b.send('run', params));
  expect(error(r)).toBeUndefined();
  return (result(r) as { runId: string }).runId;
}

/** Waits for the run's nth `run.settled` push (a record can settle once per segment) and returns its data. */
async function settled(b: TestBridge, runId: string, occurrence = 1): Promise<Record<string, unknown>> {
  await b.waitFor(
    (lines) => lines.filter((m) => m.event === 'run.settled' && m.runId === runId).length >= occurrence,
    `run.settled #${occurrence} for ${runId}`
  );
  const push = b.pushes(runId).filter((p) => p.event === 'run.settled')[occurrence - 1];
  return push!.data as Record<string, unknown>;
}

const conversation = (messages: readonly Message[] | undefined) =>
  (messages ?? []).map((m) => `${m.role}:${textOf(m)}`);

describe('bridge runs', () => {
  it('run: response first, then agent + span pushes, then run.settled', async () => {
    model = mockModel(['hi there']);
    LLMProviderRegistry.register('mock', () => model);
    const b = bridge();
    await hello(b);
    const reqId = b.send('run', runParams());
    const rid = await b.response(reqId);
    const runId = (result(rid) as { runId: string }).runId;

    const data = await settled(b, runId);

    // The response line precedes every push of this run.
    const lines = b.lines();
    const responseAt = lines.findIndex((m) => m.id === reqId);
    const firstPushAt = lines.findIndex((m) => m.event !== undefined && m.runId === runId);
    expect(responseAt).toBeGreaterThanOrEqual(0);
    expect(firstPushAt).toBeGreaterThan(responseAt);
    expect(data.finishReason).toBe('stop');
    expect(data.text).toBe('hi there');

    const events = b.pushes(runId).map((p) => p.event);
    const agentTypes = b
      .pushes(runId)
      .filter((p) => p.event === 'agent')
      .map((p) => (p.data as { type: string }).type);
    expect(agentTypes).toContain('run.start');
    expect(agentTypes).toContain('run.done');
    expect(events).toContain('span.start');
    expect(events).toContain('span.end');
    expect(events.indexOf('run.settled')).toBe(events.length - 1);
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('chat: the model sees every prior message and the result keeps one system message', async () => {
    model = mockModel(['ok']);
    LLMProviderRegistry.register('mock', () => model);
    const b = bridge();
    await hello(b);
    const rid = await b.response(
      b.send('chat',
        runParams({
          input: undefined,
          messages: [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
          ],
        })
      )
    );
    expect(error(rid)).toBeUndefined();
    const runId = (result(rid) as { runId: string }).runId;
    const data = await settled(b, runId);
    const convo = conversation(model.lastCall?.messages as Message[] | undefined);
    expect(convo).toEqual(expect.arrayContaining(['user:a', 'assistant:b', 'user:c']));
    const systems = (data.messages as Message[]).filter((m) => m.role === 'system');
    expect(systems).toHaveLength(1);
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('pauses on an asked permission and lists the approval under the agent dir', async () => {
    model = mockModel([
      { toolCalls: [{ name: 'current_date', args: {} }] },
      'done',
    ]);
    LLMProviderRegistry.register('mock', () => model);
    const b = bridge();
    await hello(b);
    const spec: AgentSpecV2 = {
      ...SPEC,
      tools: [{ builtin: 'current_date' }],
      permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
    };
    const runId = await startRun(b, runParams({ spec }));
    const data = await settled(b, runId);
    expect(data.finishReason).toBe('awaiting-approval');
    expect((data.pendingApproval as { toolName: string }).toolName).toBe('current_date');

    const approvalsDir = path.join(b.root, '.lousho', 'agents', 'agent1', 'approvals');
    expect(readdirSync(approvalsDir).filter((f) => f.endsWith('.json')).length).toBeGreaterThan(0);
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('resolveApproval continues the paused run to a final settle', async () => {
    model = mockModel([
      { toolCalls: [{ name: 'current_date', args: {} }] },
      'after approval',
    ]);
    LLMProviderRegistry.register('mock', () => model);
    const b = bridge();
    await hello(b);
    const spec: AgentSpecV2 = {
      ...SPEC,
      tools: [{ builtin: 'current_date' }],
      permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
    };
    const runId = await startRun(b, runParams({ spec }));
    const paused = await settled(b, runId);
    const approvalId = (paused.pendingApproval as { id: string }).id;

    const r = await b.response(b.send('resolveApproval', { runId, approvalId, approved: true }));
    expect(result(r)).toEqual({ ok: true });
    const data = await settled(b, runId, 2);
    expect(data.finishReason).not.toBe('awaiting-approval');
    expect(data.text).toBe('after approval');
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('resolveApproval rejects a wrong id and an unknown run', async () => {
    model = mockModel([{ toolCalls: [{ name: 'current_date', args: {} }] }, 'x']);
    LLMProviderRegistry.register('mock', () => model);
    const b = bridge();
    await hello(b);
    const spec: AgentSpecV2 = {
      ...SPEC,
      tools: [{ builtin: 'current_date' }],
      permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
    };
    const runId = await startRun(b, runParams({ spec }));
    await settled(b, runId);

    const wrong = await b.response(b.send('resolveApproval', { runId, approvalId: 'nope', approved: true }));
    expect(error(wrong)).toMatchObject({ code: 'LOUSHO_APPROVAL_NOT_FOUND' });
    const unknown = await b.response(b.send('resolveApproval', { runId: 'missing', approvalId: 'x', approved: true }));
    expect(error(unknown)).toMatchObject({ code: 'LOUSHO_BRIDGE_RUN_NOT_FOUND' });
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('answerQuestion resumes an ask_question pause with the answer in the next request', async () => {
    model = mockModel([
      { toolCalls: [{ name: 'ask_question', args: { question: 'Where to?' } }] },
      'noted',
    ]);
    LLMProviderRegistry.register('mock', () => model);
    const b = bridge();
    await hello(b);
    const spec: AgentSpecV2 = { ...SPEC, askQuestion: true };
    const runId = await startRun(b, runParams({ spec }));
    const paused = await settled(b, runId);
    expect(paused.finishReason).toBe('awaiting-approval');
    expect((paused.pendingApproval as { kind?: string }).kind).toBe('question');
    const questionId = (paused.pendingApproval as { id: string }).id;

    const r = await b.response(b.send('answerQuestion', { runId, questionId, answer: 'Lisbon' }));
    expect(result(r)).toEqual({ ok: true });
    await settled(b, runId, 2);
    const lastReq = JSON.stringify(model.lastCall?.messages ?? []);
    expect(lastReq).toContain('Lisbon');
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('steer during a gated run applies and later pushes steer.joined', async () => {
    model = mockModel([{ text: 'slow', delayMs: 5000 }, 'done']);
    LLMProviderRegistry.register('mock', () => model);
    const b = bridge();
    await hello(b);
    const runId = await startRun(b);
    await b.waitFor(() => model.calls.length === 1, 'first model call');

    const r = await b.response(b.send('steer', { runId, message: 'Actually, Paris.' }));
    const steered = result(r) as { id: string; applied: string };
    expect(['immediate', 'queued']).toContain(steered.applied);

    await b.waitFor(
      (lines) => lines.some((m) => m.event === 'steer.joined' && m.runId === runId),
      'steer.joined'
    );
    const joined = b.pushes(runId).find((p) => p.event === 'steer.joined');
    expect(joined!.data).toEqual({ steerId: steered.id, joined: true });
    const data = await settled(b, runId);
    expect(data.text).toBe('done');
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('abort during a run settles aborted with the reason', async () => {
    model = mockModel([{ text: 'late', delayMs: 60000 }]);
    LLMProviderRegistry.register('mock', () => model);
    const b = bridge();
    await hello(b);
    const runId = await startRun(b);
    await b.waitFor(() => model.calls.length === 1, 'first model call');

    const r = await b.response(b.send('abort', { runId }));
    expect(result(r)).toEqual({ state: 'aborting' });
    const data = await settled(b, runId);
    expect(data.finishReason).toBe('aborted');
    expect((data.abortReason as { message: string }).message).toBe('user');
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('abort of a paused run discards it and resolves later lookups as not found', async () => {
    model = mockModel([{ toolCalls: [{ name: 'current_date', args: {} }] }, 'x']);
    LLMProviderRegistry.register('mock', () => model);
    const b = bridge();
    await hello(b);
    const spec: AgentSpecV2 = {
      ...SPEC,
      tools: [{ builtin: 'current_date' }],
      permissions: [{ id: 'p1', tool: 'current_date', action: 'ask' }],
    };
    const runId = await startRun(b, runParams({ spec }));
    await settled(b, runId);

    const r = await b.response(b.send('abort', { runId }));
    expect(result(r)).toEqual({ state: 'discarded' });
    const approvalsDir = path.join(b.root, '.lousho', 'agents', 'agent1', 'approvals');
    expect(readdirSync(approvalsDir).filter((f) => f.endsWith('.json'))).toHaveLength(0);

    const after = await b.response(b.send('resolveApproval', { runId, approvalId: 'x', approved: true }));
    expect(error(after)).toMatchObject({ code: 'LOUSHO_BRIDGE_RUN_NOT_FOUND' });
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('abort of an unknown run reports idle', async () => {
    const b = bridge();
    await hello(b);
    const r = await b.response(b.send('abort', { runId: 'nope' }));
    expect(result(r)).toEqual({ state: 'idle' });
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('rejects a spec with flow as LOUSHO_HOST_UNSUPPORTED', async () => {
    const b = bridge();
    await hello(b);
    const spec = {
      ...SPEC,
      flow: {
        code: 'f',
        name: 'F',
        flow: { type: 'sequence', id: 's', steps: [{ type: 'end', id: 'e' }] },
      },
    };
    const r = await b.response(b.send('run', runParams({ spec })));
    expect(error(r)).toMatchObject({ code: 'LOUSHO_HOST_UNSUPPORTED' });
    b.stdin.end();
    await expect(b.done).resolves.toBe(0);
  });

  it('shutdown during a live run settles it aborted before the bridge exits', async () => {
    model = mockModel([{ text: 'late', delayMs: 60000 }]);
    LLMProviderRegistry.register('mock', () => model);
    const b = bridge();
    await hello(b);
    const runId = await startRun(b);
    await b.waitFor(() => model.calls.length === 1, 'first model call');

    const r = await b.response(b.send('shutdown'));
    expect(result(r)).toEqual({ ok: true });
    await expect(b.done).resolves.toBe(0);
    const data = b.pushes(runId).find((p) => p.event === 'run.settled');
    expect((data!.data as { finishReason: string }).finishReason).toBe('aborted');
  });
});
