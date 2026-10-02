/**
 * LOU-D45: the time-travel routes - `GET /runs/:id/history`,
 * `POST /runs/:id/fork` and `GET /runs/compare` - against real runs of the
 * mock provider, through the same RunManager lifecycle as every other run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import request from 'supertest';
import type { AgentSpec } from '@lousho/build-ai-agent';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import type { AgentRunStatusPayload, RunComparisonPayload, RunHistoryPayload } from '../../shared/wireTypes';

const SPEC: AgentSpec = {
  name: 'time-travel-agent',
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
};
const GATED_SPEC: AgentSpec = { ...SPEC, tools: ['demo-approval'] };

function settled(runManager: RunManager, runId: string, status: AgentRunStatusPayload['status']): Promise<AgentRunStatusPayload> {
  if (runManager.status(runId).status === status) return Promise.resolve(runManager.status(runId));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${runId} to be ${status}`)), 3000);
    const onStatus = (payload: AgentRunStatusPayload) => {
      if (payload.agentId !== runId || payload.status !== status) return;
      clearTimeout(timer);
      runManager.off('status', onStatus);
      resolve(payload);
    };
    runManager.on('status', onStatus);
  });
}

describe('LOU-D45 time-travel routes', () => {
  let baseDir: string;
  let runManager: RunManager;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-d45-app-test-'));
    const agentStore = createFsAgentStore(baseDir);
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: (id) => agentStore.load(id),
      saveSpec: (id, spec) => agentStore.save(id, spec),
    });
    app = createApp({ agentStore, runManager, baseDir });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  async function finishedRun(runId: string): Promise<void> {
    await request(app).post(`/agents/${runId}/run`).send({ input: 'What is the weather?', spec: SPEC }).expect(202);
    await settled(runManager, runId, 'stopped');
  }

  it('GET /runs/:id/history lists the steps with status, finish reason, tool calls and tokens', async () => {
    await finishedRun('weather');
    const res = await request(app).get('/runs/weather/history').expect(200);
    const body = res.body as RunHistoryPayload;
    expect(body.runId).toBe('weather');
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]).toMatchObject({ step: 1, status: 'finished', finishReason: 'stop', toolCalls: [] });
    expect(body.steps[0].tokens).toBeGreaterThan(0);
    expect(new Date(body.steps[0].savedAt).toISOString()).toBe(body.steps[0].savedAt);
  });

  it('GET /runs/:id/history is 404 for a run without checkpoints and 400 for an invalid id', async () => {
    await request(app).get('/runs/never-ran/history').expect(404);
    await request(app).get(`/runs/${encodeURIComponent('../x')}/history`).expect(400);
  });

  it('POST /runs/:id/fork with appendInput starts the fork through the registry; compare shows where it diverged', async () => {
    await finishedRun('weather');
    const fork = await request(app)
      .post('/runs/weather/fork')
      .send({ fromStep: 1, patch: { appendInput: 'And in Celsius?' } })
      .expect(202);
    expect(fork.body).toMatchObject({ runId: 'weather.fork-1', fromStep: 1 });
    expect(['running', 'stopped']).toContain(fork.body.status.status);

    const done = await settled(runManager, 'weather.fork-1', 'stopped');
    expect(done.resultText).toBeTruthy();
    expect((await request(app).get('/runs/weather.fork-1/history').expect(200)).body.steps.at(-1).step).toBe(2);

    const compare = await request(app).get('/runs/compare').query({ a: 'weather', b: 'weather.fork-1' }).expect(200);
    const comparison = compare.body as RunComparisonPayload;
    expect(comparison.a).toHaveLength(1);
    expect(comparison.b).toHaveLength(2);
    expect(comparison.divergedAt).toBe(2);
    expect(comparison.drift).toContainEqual({ field: 'steps', committed: '1', current: '2' });
  });

  it('POST /runs/:id/fork with toolResult answers a call paused for approval; history shows the call', async () => {
    await request(app).post('/agents/gated/run').send({ input: 'please use demo-approval', spec: GATED_SPEC }).expect(202);
    await settled(runManager, 'gated', 'paused');
    const [step] = (await request(app).get('/runs/gated/history').expect(200)).body.steps as RunHistoryPayload['steps'];
    expect(step).toMatchObject({ step: 1, status: 'awaiting-approval', finishReason: 'tool_calls' });
    expect(step.toolCalls).toEqual([expect.objectContaining({ name: 'demo-approval' })]);
    expect(step.toolCalls[0].result).toBeUndefined();

    const toolCallId = step.toolCalls[0].id;
    const fork = await request(app)
      .post('/runs/gated/fork')
      .send({ fromStep: 1, patch: { toolResult: { toolCallId, result: { done: false, note: 'edited' } } } })
      .expect(202);
    await settled(runManager, fork.body.runId, 'stopped');
    expect(runManager.status('gated').status).toBe('paused'); // the source run is untouched

    const comparison = (await request(app).get(`/runs/compare?a=gated&b=${fork.body.runId}`).expect(200)).body as RunComparisonPayload;
    expect(comparison.divergedAt).toBe(1);
    expect(comparison.b[0].tools[0].result).toBe(JSON.stringify({ done: false, note: 'edited' }));
  });

  it('POST /runs/:id/fork validates its body and maps fork errors', async () => {
    await finishedRun('weather');
    const fork = (body: object) => request(app).post('/runs/weather/fork').send(body);
    await fork({}).expect(400);
    await fork({ fromStep: -1 }).expect(400);
    await fork({ fromStep: 1.5 }).expect(400);
    await fork({ fromStep: 1, patch: [] }).expect(400);
    await fork({ fromStep: 1, patch: { messages: [] } }).expect(400);
    await fork({ fromStep: 1, patch: { appendInput: '  ' } }).expect(400);
    await fork({ fromStep: 1, patch: { toolResult: 'x' } }).expect(400);
    await fork({ fromStep: 1, patch: { toolResult: { toolCallId: 'c1' } } }).expect(400);
    const unknownCall = await fork({ fromStep: 1, patch: { toolResult: { toolCallId: 'nope', result: 1 } } }).expect(400);
    expect(unknownCall.body.error).toMatch(/no tool call 'nope'/);
    const noStep = await fork({ fromStep: 9 }).expect(404);
    expect(noStep.body.error).toMatch(/no checkpoint at step 9/);
    await request(app).post('/runs/unknown/fork').send({ fromStep: 1 }).expect(404);
  });

  it('GET /runs/compare validates its query and is 404 when a run has no checkpoint', async () => {
    await finishedRun('weather');
    await request(app).get('/runs/compare?a=weather').expect(400);
    await request(app).get(`/runs/compare?a=weather&b=${encodeURIComponent('../x')}`).expect(400);
    await request(app).get('/runs/compare?a=weather&b=missing').expect(404);
    const same = (await request(app).get('/runs/compare?a=weather&b=weather').expect(200)).body as RunComparisonPayload;
    expect(same.divergedAt).toBeUndefined();
    expect(same.drift).toEqual([]);
  });
});
