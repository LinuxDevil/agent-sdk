/**
 * T05 - `RunManager.steer()` end to end through the real InProcessAgentHost
 * and SDK: a registered 'steergate' provider parks its model call on a
 * test-released gate so the run is reliably `running` while the test
 * steers it.
 *
 * - 'before-output' + a gated first call: steer() applies 'immediate'
 *   (aborts the silent call), the run re-calls the model WITH the steered
 *   message, delivery flips to 'delivered', and the transcript bubble is
 *   tagged source 'steer'.
 * - 'after-delta' + maxSteps: 1: the call already emitted, so steer()
 *   applies 'queued'; the step budget is spent so the run ends without
 *   another model call - delivery 'undelivered' plus the warn log line.
 * - A gated flow run rejects with SteerUnsupportedError.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { type AgentSpecV2 } from 'lousho';
import { RunManager, NoActiveRunError, SteerUnsupportedError } from '../runRegistry';
import { newTestHost } from './testHost';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import type { LogEntry } from '../../shared/wireTypes';
import { deferred, resetSteerGate, setSteerGateScript, steerGateProviders } from './steerGate';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'steer-agent',
  model: 'steergate/steer-1',
  instructions: 'You are a test agent.',
};

/** A flow spec on the same gated provider: its llmCall parks until released. */
const FLOW_SPEC = {
  version: 2,
  name: 'steer-flow',
  model: 'steergate/steer-1',
  instructions: 'Run the flow.',
  flow: {
    code: 'steer-flow',
    name: 'steer-flow',
    flow: { type: 'llmCall', prompt: 'classify', outputVariable: 'x' },
  },
} as unknown as AgentSpecV2;

function waitForStatus(
  runManager: RunManager,
  agentId: string,
  predicate: (status: { status: string }) => boolean,
  timeoutMs = 5000
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

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function messageText(message: { content: unknown }): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

describe('RunManager.steer (T05)', () => {
  let baseDir: string;
  let runManager: RunManager;

  beforeEach(() => {
    resetSteerGate();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-n-steer-'));
    runManager = new RunManager({
      baseDir,
      checkpointStore: new FileCheckpointStore(baseDir),
      approvalStore: new FileApprovalStore(baseDir),
      host: newTestHost(baseDir),
      loadSpec: async () => undefined,
      saveSpec: async () => {},
    });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('rejects with NoActiveRunError when nothing is running', async () => {
    await expect(runManager.steer('never-ran', 'hello')).rejects.toThrow(NoActiveRunError);
    await expect(runManager.steer('never-ran', 'hello')).rejects.toThrow(
      'Nothing is running, so there is nothing to steer.'
    );
  });

  it('rejects with SteerUnsupportedError for a running flow', async () => {
    const gate = deferred();
    setSteerGateScript({ blockCalls: 1, mode: 'before-output', gate: gate.promise });
    await runManager.run('steer-flow', 'go', FLOW_SPEC);
    await waitForStatus(runManager, 'steer-flow', (s) => s.status === 'running');
    await waitFor(() => steerGateProviders.at(-1)?.calls.length === 1, 'the flow llmCall to reach the provider');

    await expect(runManager.steer('steer-flow', 'change course')).rejects.toThrow(SteerUnsupportedError);
    await expect(runManager.steer('steer-flow', 'change course')).rejects.toThrow(
      'Flow runs cannot be steered yet.'
    );

    gate.resolve();
    await waitForStatus(runManager, 'steer-flow', (s) => s.status !== 'running', 10000);
  });

  it('delivers a steer into a running agent: applied immediate, delivery delivered, transcript tagged steer', async () => {
    const gate = deferred();
    setSteerGateScript({ blockCalls: 1, mode: 'before-output', gate: gate.promise });
    await runManager.run('steer-ok', 'hello', SPEC);
    const provider = steerGateProviders[0];
    await waitFor(() => provider.calls.length === 1, 'the first model call to start');

    const response = await runManager.steer('steer-ok', 'actually use Paris');
    expect(response.applied).toBe('immediate');
    expect(typeof response.id).toBe('string');

    // The steer is on the status payload right away, still 'queued' until
    // the re-called model call picks it up.
    const during = runManager.status('steer-ok');
    expect(during.steering).toHaveLength(1);
    expect(during.steering?.[0]).toMatchObject({
      id: response.id,
      message: 'actually use Paris',
      delivery: 'queued',
      mode: 'immediate',
    });

    // The aborted first call is re-made WITH the steered message (the SDK's
    // steer contract), then the run finishes on its own.
    await waitFor(() => provider.calls.length === 2, 'the re-called model call');
    expect(provider.calls[1].messages.some((m) => m.role === 'user' && messageText(m).includes('actually use Paris'))).toBe(
      true
    );
    const done = await waitForStatus(runManager, 'steer-ok', (s) => s.status === 'done');
    expect(done.steering?.[0]?.delivery).toBe('delivered');

    // The delivered steer joined the transcript as a user turn tagged
    // source 'steer' - the ChatPanel's "Steered" bubble.
    const steerBubble = runManager
      .chatState('steer-ok')
      .messages.find((m) => m.role === 'user' && m.content === 'actually use Paris');
    expect(steerBubble?.source).toBe('steer');
  });

  it('marks a steer undelivered when the run ends before another model call, and logs a warn line', async () => {
    const gate = deferred();
    // maxSteps: 1 spends the whole step budget on the gated call, so the
    // 'stop' outcome cannot take another step for the queued input.
    setSteerGateScript({ blockCalls: 1, mode: 'after-delta', gate: gate.promise });
    const logs: LogEntry[] = [];
    runManager.on('log', (agentId: string, entry: LogEntry) => {
      if (agentId === 'steer-late') logs.push(entry);
    });
    const sawDelta = new Promise<void>((resolve) => {
      runManager.on('event', (agentId: string, event: { type: string }) => {
        if (agentId === 'steer-late' && event.type === 'text.delta') resolve();
      });
    });
    await runManager.run('steer-late', 'hello', { ...SPEC, maxSteps: 1 });
    const provider = steerGateProviders[0];
    await waitFor(() => provider.calls.length === 1, 'the model call to start');
    await sawDelta; // callOutput() ran before the delta event - a steer now queues.

    const response = await runManager.steer('steer-late', 'too late');
    expect(response.applied).toBe('queued');
    expect(runManager.status('steer-late').steering?.[0]).toMatchObject({
      id: response.id,
      delivery: 'queued',
      mode: 'queued',
    });

    gate.resolve();
    const done = await waitForStatus(runManager, 'steer-late', (s) => s.status !== 'running');
    expect(done.steering?.[0]?.delivery).toBe('undelivered');

    // The warn log line the ticket fixes, and no 'steer'-tagged bubble
    // (the message never joined the transcript).
    expect(
      logs.some(
        (l) =>
          l.level === 'warn' &&
          l.message === 'Steering message not delivered: the run ended first.' &&
          (l.detail as { id?: string })?.id === response.id
      )
    ).toBe(true);
    expect(
      runManager.chatState('steer-late').messages.some((m) => m.content === 'too late')
    ).toBe(false);
  });

  it('resets the steering list when the next run launches', async () => {
    const gate = deferred();
    setSteerGateScript({ blockCalls: 1, mode: 'before-output', gate: gate.promise });
    await runManager.run('steer-reset', 'hello', SPEC);
    const provider = steerGateProviders[0];
    await waitFor(() => provider.calls.length === 1, 'the first model call to start');
    await runManager.steer('steer-reset', 'first run note');
    gate.resolve();
    await waitForStatus(runManager, 'steer-reset', (s) => s.status === 'done');
    expect(runManager.status('steer-reset').steering).toHaveLength(1);

    // The next launch starts with an empty steering list on its status.
    const gate2 = deferred();
    setSteerGateScript({ blockCalls: 1, mode: 'before-output', gate: gate2.promise });
    await runManager.run('steer-reset', 'again', SPEC);
    expect(runManager.status('steer-reset').steering ?? []).toHaveLength(0);
    gate2.resolve();
    await waitForStatus(runManager, 'steer-reset', (s) => s.status === 'done', 10000);
  });
});
