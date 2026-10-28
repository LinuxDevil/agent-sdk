/**
 * Builder runs (`RunManager.run()`) report to the observe daemon the Studio
 * reads, as agent `<agentId>`, through the same reporter factory the
 * playground uses (observeReporting.ts) - so the top bar's "Open trace" link
 * (`#/traces/<traceId>`) resolves. The run status carries that trace id.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentSpec } from '@lousho/build-ai-agent';
import { RunManager } from '../runRegistry';
import { agentTraceDir } from '../traceStore';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';

type Ingested = { type: string; data: Record<string, unknown> };

const SPEC: AgentSpec = {
  name: 'builder-agent',
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
};

function waitForDone(runManager: RunManager, agentId: string): Promise<{ status: string; traceId?: string }> {
  return new Promise((resolve) => {
    const onStatus = (payload: { agentId: string; status: string; traceId?: string }) => {
      if (payload.agentId !== agentId || payload.status !== 'done') return;
      runManager.off('status', onStatus);
      resolve(payload);
    };
    runManager.on('status', onStatus);
  });
}

describe('builder run reporting', () => {
  let baseDir: string;
  let ingested: Ingested[];
  const savedObserve = process.env.LOUSHO_OBSERVE;

  function makeManager(observe: ConstructorParameters<typeof RunManager>[0]['observe']): RunManager {
    return new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      loadSpec: async () => undefined,
      ...(observe ? { observe } : {}),
    });
  }

  const fetchFn = () =>
    (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { batch?: Ingested[] };
      ingested.push(...(body.batch ?? []));
      return new Response(JSON.stringify({ accepted: body.batch?.length ?? 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

  beforeEach(() => {
    delete process.env.LOUSHO_OBSERVE;
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-report-'));
    ingested = [];
  });

  afterEach(() => {
    if (savedObserve === undefined) delete process.env.LOUSHO_OBSERVE;
    else process.env.LOUSHO_OBSERVE = savedObserve;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const rootEnd = () =>
    ingested.find((e) => e.type === 'observation' && e.data.parent_obs_id === undefined && e.data.end !== undefined);

  it("reports a builder run's spans as agent <agentId>, and the status names the trace", async () => {
    const runManager = makeManager({ url: 'http://127.0.0.1:7998', fetchFn: fetchFn(), registerExitHooks: false, flushIntervalMs: 10 });
    const done = waitForDone(runManager, 'support-desk');
    await runManager.run('support-desk', 'hello', SPEC);
    const final = await done;
    expect(typeof final.traceId).toBe('string');
    await vi.waitFor(() => expect(rootEnd()).toBeDefined());
    expect(ingested.find((e) => e.type === 'agent.heartbeat')?.data.name).toBe('support-desk');
    expect(rootEnd()!.data.trace_id).toBe(final.traceId);
    expect(runManager.status('support-desk').traceId).toBe(final.traceId);
  });

  it('captures message content for a loopback daemon only', async () => {
    const reportTo = async (url: string, agentId: string) => {
      ingested = [];
      const runManager = makeManager({ url, fetchFn: fetchFn(), registerExitHooks: false, flushIntervalMs: 10 });
      const done = waitForDone(runManager, agentId);
      await runManager.run(agentId, 'hello', SPEC);
      await done;
      await vi.waitFor(() => expect(rootEnd()).toBeDefined());
      return JSON.stringify(ingested);
    };
    expect(await reportTo('http://127.0.0.1:7998', 'local-agent')).toContain('gen_ai.input.messages');
    expect(await reportTo('http://observe.internal:7777', 'remote-agent')).not.toContain('gen_ai.input.messages');
  });

  it('keeps captured content observe-only: the trace file and live feed get none', async () => {
    const runManager = makeManager({ url: 'http://127.0.0.1:7998', fetchFn: fetchFn(), registerExitHooks: false, flushIntervalMs: 10 });
    const live: string[] = [];
    runManager.on('span', (payload: unknown) => live.push(JSON.stringify(payload)));
    const done = waitForDone(runManager, 'private-agent');
    await runManager.run('private-agent', 'hello', SPEC);
    await done;
    await vi.waitFor(() => expect(rootEnd()).toBeDefined());
    expect(JSON.stringify(ingested)).toContain('gen_ai.input.messages');

    const traceFiles = (fs.readdirSync(agentTraceDir(baseDir, 'private-agent'), { recursive: true }) as string[])
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => fs.readFileSync(path.join(agentTraceDir(baseDir, 'private-agent'), f), 'utf8'));
    expect(traceFiles.join('')).toContain('invoke_agent');
    expect(traceFiles.join('')).not.toContain('gen_ai.input.messages');
    expect(live.length).toBeGreaterThan(0);
    expect(live.join('')).not.toContain('gen_ai.input.messages');
  });

  it('a daemon that is down never fails the run', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const runManager = makeManager({ url: 'http://127.0.0.1:7998', fetchFn: down, registerExitHooks: false, flushIntervalMs: 10 });
    const done = waitForDone(runManager, 'offline');
    await runManager.run('offline', 'hello', SPEC);
    expect((await done).status).toBe('done');
  });

  it('without the observe option the manager makes no reporter of its own', async () => {
    const runManager = makeManager(undefined);
    const done = waitForDone(runManager, 'quiet');
    await runManager.run('quiet', 'hello', SPEC);
    const final = await done;
    // The status still names the run's trace (the local trace file has it too).
    expect(typeof final.traceId).toBe('string');
    expect(ingested).toEqual([]);
  });
});
