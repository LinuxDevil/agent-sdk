/**
 * M5b: persisted trace history - a run writes the SDK's trace files under the
 * agent's folder and `GET /agents/:id/traces[/:traceId]` reads them back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import request from 'supertest';
import { listTraces } from '@lousho/build-ai-agent/traces';
import type { AgentSpec } from '@lousho/build-ai-agent';
import { createApp } from '../app';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';
import type { AgentRunStatusPayload, TraceDetailPayload, TraceSummaryPayload } from '../../shared/wireTypes';

const SPEC: AgentSpec = {
  name: 'trace-agent',
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
};

function stopped(runManager: RunManager, agentId: string): Promise<AgentRunStatusPayload> {
  if (runManager.status(agentId).status === 'done') return Promise.resolve(runManager.status(agentId));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${agentId}`)), 3000);
    const onStatus = (payload: AgentRunStatusPayload) => {
      if (payload.agentId !== agentId || payload.status !== 'done') return;
      clearTimeout(timer);
      runManager.off('status', onStatus);
      resolve(payload);
    };
    runManager.on('status', onStatus);
  });
}

describe('M5b trace history routes', () => {
  let baseDir: string;
  let runManager: RunManager;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-m5b-test-'));
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

  async function finishedRun(agentId: string, input = 'What is the weather?'): Promise<void> {
    await request(app).post(`/agents/${agentId}/run`).send({ input, spec: SPEC }).expect(202);
    await stopped(runManager, agentId);
  }

  it('a run writes a trace file under the agent folder, readable with the SDK reader', async () => {
    await finishedRun('weather');
    const dir = path.join(baseDir, '.lousho', 'agents', 'weather', 'traces');
    expect(fs.existsSync(dir)).toBe(true);
    const summaries = await listTraces({ dir });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].file.startsWith(dir)).toBe(true);
  });

  it('GET /agents/:id/traces lists the runs newest first, without file paths', async () => {
    await finishedRun('weather');
    await finishedRun('weather', 'And tomorrow?');
    const res = await request(app).get('/agents/weather/traces').expect(200);
    const traces = (res.body as { traces: TraceSummaryPayload[] }).traces;
    expect(traces).toHaveLength(2);
    expect(traces[0].startTime).toBeGreaterThanOrEqual(traces[1].startTime);
    expect(traces[0].status).toBe('ok');
    expect(traces[0].modelCalls).toBeGreaterThan(0);
    expect(traces[0]).not.toHaveProperty('file');
    expect(JSON.stringify(res.body)).not.toContain('lou-m5b-test-');

    const limited = await request(app).get('/agents/weather/traces?limit=1').expect(200);
    expect(limited.body.traces).toHaveLength(1);
  });

  it('GET /agents/:id/traces/:traceId returns the spans with kind and status', async () => {
    await finishedRun('weather');
    const [summary] = (await request(app).get('/agents/weather/traces').expect(200)).body.traces as TraceSummaryPayload[];
    const res = await request(app).get(`/agents/weather/traces/${summary.traceId}`).expect(200);
    const body = res.body as TraceDetailPayload;
    expect(body.traceId).toBe(summary.traceId);
    const root = body.spans.find((s) => s.id === summary.traceId);
    expect(root).toMatchObject({ kind: 'internal' });
    expect(body.spans.find((s) => s.attributes['gen_ai.operation.name'] === 'chat')).toMatchObject({ kind: 'client' });
  });

  it('a failed span keeps its error status in the list and the detail', async () => {
    const dir = path.join(baseDir, '.lousho', 'agents', 'broken', 'traces', '2026-10-02');
    fs.mkdirSync(dir, { recursive: true });
    const root = { v: 1, traceId: 'r1', id: 'r1', name: 'invoke_agent broken', kind: 'internal', startTime: 1000, endTime: 1500, attributes: {}, status: { code: 'error', message: 'boom' } };
    const tool = { v: 1, traceId: 'r1', id: 't1', parentId: 'r1', name: 'execute_tool x', kind: 'internal', startTime: 1100, endTime: 1200, attributes: {}, status: { code: 'error', message: 'boom' } };
    const lines = [tool, root].map((line) => `${JSON.stringify(line)}
`).join('');
    fs.writeFileSync(path.join(dir, 'r1.jsonl'), lines);
    expect((await request(app).get('/agents/broken/traces').expect(200)).body.traces[0]).toMatchObject({ traceId: 'r1', status: 'error' });
    const detail = (await request(app).get('/agents/broken/traces/r1').expect(200)).body as TraceDetailPayload;
    expect(detail.spans.map((s) => s.status)).toEqual([{ code: 'error', message: 'boom' }, { code: 'error', message: 'boom' }]);
  });

  it('an agent without runs has an empty list; an unknown agent is 404', async () => {
    await request(app).put('/agents/fresh').send(SPEC).expect(204);
    expect((await request(app).get('/agents/fresh/traces').expect(200)).body).toEqual({ traces: [] });
    await request(app).get('/agents/nobody/traces').expect(404);
    await request(app).get('/agents/nobody/traces/abc').expect(404);
  });

  it('an unknown trace is 404', async () => {
    await finishedRun('weather');
    await request(app).get('/agents/weather/traces/00000000-0000-0000-0000-000000000000').expect(404);
  });

  it('a path-like trace or agent id is 400 and never reaches the filesystem', async () => {
    await finishedRun('weather');
    for (const bad of ['..%2F..%2Fagent.yaml', '..', 'a%2Fb', 'a%5Cb', '%2E%2E', 'x.jsonl']) {
      const res = await request(app).get(`/agents/weather/traces/${bad}`);
      expect(res.status, bad).not.toBe(200);
      expect(res.status, bad).toBeLessThan(500);
    }
    await request(app).get('/agents/weather/traces/..%2F..%2Fagent.yaml').expect(400);
    await request(app).get('/agents/weather/traces/a%5Cb').expect(400);
    await request(app).get('/agents/..%2Fweather/traces').expect(400);
  });

  it('an ambiguous id prefix is 400', async () => {
    await finishedRun('weather');
    const dir = path.join(baseDir, '.lousho', 'agents', 'weather', 'traces');
    const [day] = fs.readdirSync(dir);
    for (const name of ['ab-1', 'ab-2']) {
      const line = { v: 1, traceId: name, id: name, name: 'invoke_agent x', startTime: 1, endTime: 2, attributes: {} };
      fs.writeFileSync(path.join(dir, day, `${name}.jsonl`), `${JSON.stringify(line)}\n`);
    }
    await request(app).get('/agents/weather/traces/ab').expect(400);
  });
});
