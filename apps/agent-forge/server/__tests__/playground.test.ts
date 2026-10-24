import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import request from 'supertest';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { SecretsStore } from '../secretsStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import { substituteVariables, type PlaygroundEvent } from '../playground';

type Ingested = { type: string; data: Record<string, unknown> };

/** POSTs a playground run and parses the SSE body into its events. */
async function runPlayground(app: ReturnType<typeof createApp>, body: unknown) {
  const res = await request(app)
    .post('/playground/run')
    .send(body as object)
    .buffer(true)
    .parse((response, callback) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => callback(null, text));
    });
  const raw = String(res.body);
  const events = raw
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as PlaygroundEvent);
  return { res, events };
}

describe('POST /playground/run', () => {
  let baseDir: string;
  let app: ReturnType<typeof createApp>;
  let ingested: Ingested[];
  const savedObserve = process.env.LOUSHO_OBSERVE;

  beforeEach(() => {
    delete process.env.LOUSHO_OBSERVE;
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playground-'));
    // Each test's reporter writes to its own array: an earlier test's reporter may still flush.
    const sink: Ingested[] = [];
    ingested = sink;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { batch?: Ingested[] };
      sink.push(...(body.batch ?? []));
      return new Response(JSON.stringify({ accepted: body.batch?.length ?? 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const agentStore = createFsAgentStore(baseDir);
    const secretsStore = new SecretsStore(baseDir);
    const runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
      secretsStore,
    });
    app = createApp({
      agentStore,
      runManager,
      baseDir,
      secretsStore,
      playgroundObserve: { url: 'http://127.0.0.1:7999', fetchFn, registerExitHooks: false, flushIntervalMs: 10 },
    });
  });

  afterEach(() => {
    if (savedObserve === undefined) delete process.env.LOUSHO_OBSERVE;
    else process.env.LOUSHO_OBSERVE = savedObserve;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const rootEnd = () =>
    ingested.find((e) => e.type === 'observation' && e.data.parent_obs_id === undefined && e.data.end !== undefined);

  it('streams the mock provider as deltas, then done', async () => {
    const { res, events } = await runPlayground(app, { model: 'mock', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((e) => (e as { text: string }).text).join('')).toBe('This is a mock response.');
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: 'done', finishReason: 'stop', text: 'This is a mock response.' });
    expect(typeof (last as { traceId?: string }).traceId).toBe('string');
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('applies {var} substitution to every message before the model sees it', async () => {
    const { events } = await runPlayground(app, {
      model: 'mock/mock-model-1',
      messages: [
        { role: 'system', content: 'You are {persona}.' },
        { role: 'user', content: 'Hello {name}, keep {unknown}' },
      ],
      variables: { persona: 'a pirate', name: 'Ada' },
    });
    expect(events[events.length - 1].type).toBe('done');
    await vi.waitFor(() => expect(rootEnd()).toBeDefined());
    const input = String(rootEnd()!.data.input);
    expect(input).toContain('You are a pirate.');
    expect(input).toContain('Hello Ada, keep {unknown}');
    expect(input).not.toContain('{name}');
  });

  it('answers an unknown model with an error event, not a 500', async () => {
    const { res, events } = await runPlayground(app, { model: 'nope/model-x', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'LOUSHO_PROVIDER_UNKNOWN' });
    expect((events[0] as { message: string }).message).toMatch(/nope/);
  });

  it('reports the run as agent playground with lousho.prompt.ref', async () => {
    const { events } = await runPlayground(app, {
      model: 'mock',
      promptRef: 'greeter@prod',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const done = events[events.length - 1] as { type: string; traceId?: string };
    expect(done.type).toBe('done');
    await vi.waitFor(() => expect(rootEnd()).toBeDefined());
    const heartbeat = ingested.find((e) => e.type === 'agent.heartbeat');
    expect(heartbeat?.data.name).toBe('playground');
    const root = rootEnd()!;
    expect(root.data.trace_id).toBe(done.traceId);
    const attrs = root.data.attrs as Record<string, unknown>;
    expect(attrs['gen_ai.agent.name']).toBe('playground');
    expect(attrs['lousho.prompt.ref']).toBe('greeter@prod');
  });

  it('streams a tool_call event for a requested tool', async () => {
    const { events } = await runPlayground(app, {
      model: 'mock',
      tools: ['current-date'],
      messages: [{ role: 'user', content: 'Use current-date please' }],
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', name: 'current-date' }));
    expect(events[events.length - 1].type).toBe('done');
  });

  it('ends a run whose tool needs approval with awaiting-approval', async () => {
    const { events } = await runPlayground(app, {
      model: 'mock',
      tools: ['demo-approval'],
      messages: [{ role: 'user', content: 'call demo-approval' }],
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', name: 'demo-approval' }));
    expect(events[events.length - 1]).toMatchObject({ type: 'done', finishReason: 'awaiting-approval' });
  });

  it('streams an error event for an unknown tool', async () => {
    const { events } = await runPlayground(app, { model: 'mock', tools: ['no-such-tool'], messages: [{ role: 'user', content: 'hi' }] });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });

  it.each([
    [{}, /messages/],
    [{ model: 'mock', messages: [] }, /messages/],
    [{ model: 'mock', messages: [{ role: 'tool', content: 'x' }] }, /role/],
    [{ messages: [{ role: 'user', content: 'hi' }] }, /model/],
    [{ model: 'mock', messages: [{ role: 'user', content: 'hi' }], variables: { a: 1 } }, /variables/],
    [{ model: 'mock', messages: [{ role: 'user', content: 'hi' }], tools: 'x' }, /tools/],
    [{ model: 'mock', messages: [{ role: 'user', content: 'hi' }], promptRef: '' }, /promptRef/],
  ])('rejects a bad body with 400 (%j)', async (body, message) => {
    const res = await request(app).post('/playground/run').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });
});

describe('substituteVariables', () => {
  it('replaces known placeholders and leaves unknown ones', () => {
    expect(substituteVariables('{a} and {b} and {a}', { a: 'x' })).toBe('x and {b} and x');
    expect(substituteVariables('no vars', undefined)).toBe('no vars');
    expect(substituteVariables('{toString}', {})).toBe('{toString}');
  });
});
