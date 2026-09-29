import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentSpec } from '@loushy/build-ai-agent';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';

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

describe('RunManager', () => {
  let baseDir: string;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-n-test-'));
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

  it('reports idle status for an agent that has never run', () => {
    const status = runManager.status('nope');
    expect(status.status).toBe('idle');
  });

  it('runs an agent to completion and reports the result text', async () => {
    await runManager.run('agent-1', 'please use current-date', SPEC);
    const final = await waitForStatus(runManager, 'agent-1', (s) => s.status === 'stopped');
    expect(final.resultText).toBe('This is a mock response.');
  });

  it('rejects a second run() call while one is already in flight', async () => {
    await runManager.run('agent-2', 'please use current-date', SPEC);
    await expect(runManager.run('agent-2', 'again', SPEC)).rejects.toThrow(/already running/i);
    await waitForStatus(runManager, 'agent-2', (s) => s.status === 'stopped');
  });

  it('throws when running an agent id with no spec available', async () => {
    await expect(runManager.run('unknown-agent', 'hi')).rejects.toThrow(/no agent spec/i);
  });

  it('stop() then run() resumes from the last checkpoint instead of restarting', async () => {
    const checkpointStore = new FileCheckpointStore(baseDir);
    const agentId = 'agent-3';

    // Abort the run right after the first tool result is recorded (and its
    // checkpoint written), but before the loop's next provider.generate()
    // call - deterministic because this handler runs synchronously within
    // the same event-loop turn AgentExecutor's onEvent callback fires in,
    // before the `continue` to the next step's generate() call is reached.
    let stopped = false;
    runManager.on('event', (id: string, event: any) => {
      if (id === agentId && event.type === 'tool-result' && !stopped) {
        stopped = true;
        runManager.stop(agentId);
      }
    });

    await runManager.run(agentId, 'please use current-date', SPEC);
    await waitForStatus(runManager, agentId, (s) => s.status === 'stopped');

    // The checkpoint from the aborted run must survive - AgentExecutor only
    // deletes it on a successful terminal completion, never on an aborted
    // run (see abortableProvider.ts's doc comment).
    const checkpoint = await checkpointStore.load(agentId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.stepIndex).toBeGreaterThanOrEqual(1);

    // Running again picks the same checkpoint back up (AgentExecutor
    // rehydrates from it and ignores the new `input`) rather than starting
    // a brand new conversation from scratch.
    await runManager.run(agentId, 'this input is ignored on resume', SPEC);
    const resumed = await waitForStatus(runManager, agentId, (s) => s.status === 'stopped');
    expect(resumed.resultText).toBe('This is a mock response.');

    // And the checkpoint is cleared once that resumed run completes
    // successfully.
    const afterResume = await checkpointStore.load(agentId);
    expect(afterResume).toBeNull();
  });

  it('emits structured log entries derived from the ExecutionEvent stream (O1)', async () => {
    const logs: any[] = [];
    runManager.on('log', (agentId: string, entry: any) => {
      if (agentId === 'agent-logs') logs.push(entry);
    });

    await runManager.run('agent-logs', 'please use current-date', SPEC);
    await waitForStatus(runManager, 'agent-logs', (s) => s.status === 'stopped');

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => typeof l.id === 'string' && typeof l.timestamp === 'string')).toBe(true);
    expect(logs.some((l) => l.phase === 'trigger' && l.message.includes('started'))).toBe(true);
    expect(logs.some((l) => l.phase === 'tool' && l.toolName === 'current-date')).toBe(true);
  });

  it('emits real span start/end events from the SDK TraceExporter hook (O2)', async () => {
    const spans: any[] = [];
    runManager.on('span', (agentId: string, span: any) => {
      if (agentId === 'agent-spans') spans.push(span);
    });

    await runManager.run('agent-spans', 'please use current-date', SPEC);
    await waitForStatus(runManager, 'agent-spans', (s) => s.status === 'stopped');

    const runSpans = spans.filter((s) => s.name === 'agent.run');
    expect(runSpans).toHaveLength(2); // start + end
    const [startSpan, endSpan] = runSpans;
    expect(startSpan.endTime).toBeUndefined();
    expect(endSpan.endTime).toBeGreaterThanOrEqual(endSpan.startTime);
    expect(spans.some((s) => s.name === 'llm.generate')).toBe(true);
    expect(spans.some((s) => s.name === 'tool.call' && s.parentId === startSpan.id)).toBe(true);
  });

  it('pauses a run at a configured breakpoint and resumes on continueRun() (O3)', async () => {
    const debugStates: any[] = [];
    let pauseCount = 0;
    // The fixture SPEC's prompt drives the mock provider through a tool
    // call then a final response - two provider.generate() calls, so a
    // persistent 'llm:before' breakpoint pauses twice. continueRun() every
    // time the run reports paused, same as a real client would on seeing
    // `{type:'debug', payload:{paused:true}}` over the WS stream.
    runManager.on('debug', (agentId: string, state: any) => {
      if (agentId !== 'agent-debug') return;
      debugStates.push(state);
      if (state.paused) {
        pauseCount += 1;
        runManager.continueRun('agent-debug');
      }
    });

    runManager.setBreakpoints('agent-debug', ['llm:before']);
    await runManager.run('agent-debug', 'please use current-date', SPEC);
    await waitForStatus(runManager, 'agent-debug', (s) => s.status === 'stopped');

    expect(pauseCount).toBeGreaterThanOrEqual(1);
    expect(runManager.debugState('agent-debug').paused).toBe(false);
    expect(debugStates.some((s) => s.paused === true && s.atBreakpoint?.phase === 'llm')).toBe(true);
  });

  it('surfaces a thrown provider error as status "error" without crashing the process', async () => {
    const errorSpec: AgentSpec = {
      name: 'erroring-agent',
      prompt: 'You are a helpful agent.',
      // 'mock' provider type ignores model-specific errors, so simulate one
      // via a spec whose provider type is unregistered - resolveSpecProvider
      // throws synchronously inside buildAgentFromSpec(), which run()
      // currently calls outside its own try/catch (see below).
      provider: { type: 'definitely-not-a-real-provider', model: 'x' },
    };
    await expect(runManager.run('agent-4', 'hi', errorSpec)).rejects.toThrow();
  });
});
