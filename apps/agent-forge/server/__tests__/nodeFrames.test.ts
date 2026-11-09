import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
  APPROVAL_WAIT_SPAN_NAME,
  GenAiAttr,
  GenAiOperation,
  SdkAttr,
  emptyRunUsage,
  type AgentSpecV2,
  type Span,
} from 'lousho';
import { RunManager } from '../runRegistry';
import { newTestHost } from './testHost';
import { attachWebSocketServer } from '../wsServer';
import { createUpgradeRouter } from '../ws/upgradeRouter';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import {
  HostRunNotActiveError,
  type AgentHost,
  type HostCatalog,
  type HostEvent,
  type HostRun,
  type HostRunInput,
  type HostSteerResult,
} from '../host/agentHost';
import type { NodeStatePayload } from '../../shared/wireTypes';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'test-agent',
  model: 'mock/mock-1',
  instructions: 'You are a helpful agent.',
  tools: [{ builtin: 'current_date' }],
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

function makeSpan(id: string, name: string, attributes: Record<string, unknown>, parentId?: string): Span {
  return { id, name, attributes, startTime: Date.now(), parentId };
}

/**
 * A scripted `AgentHost`: `start()` replays `script`'s span/agent HostEvents
 * through the run's `onEvent` (exactly like `InProcessAgentHost`'s wiring
 * emits them) and settles the run on the next macrotask, so `RunManager`
 * has finished recording `hostRunId` by the time 'settled' lands.
 *
 * Exists because a run's spans only carry `lousho.node.id` when the agent
 * was compiled through the node-id exporter - so the `node`-frame path is
 * exercised here with spans stamped the way S20's nodeIdExporter stamps
 * them (see the test below for what the real in-process run emits today).
 */
class ScriptedHost implements AgentHost {
  readonly kind = 'in-process' as const;
  readonly sdkVersion = 'scripted';
  constructor(private readonly script: (emit: (event: HostEvent) => void) => void) {}

  async start(input: HostRunInput): Promise<HostRun> {
    this.script(input.onEvent);
    setTimeout(
      () =>
        input.onEvent({
          type: 'settled',
          result: {
            finishReason: 'stop',
            text: 'scripted done',
            messages: [{ role: 'assistant', content: 'scripted done' }],
            usage: emptyRunUsage(),
            steps: 1,
          },
        }),
      0
    );
    return { runId: 'scripted-run', modelLabel: 'mock/mock-1' };
  }

  async steer(): Promise<HostSteerResult> {
    throw new HostRunNotActiveError('scripted host does not steer');
  }
  async abort(): Promise<void> {}
  async resolveApproval(): Promise<void> {}
  async answerQuestion(): Promise<void> {}
  async catalog(): Promise<HostCatalog> {
    return { tools: [], models: [], guardrails: [], triggers: [] };
  }
  async dispose(): Promise<void> {}
}

/** The span sequence a one-tool run emits, with S20's `lousho.node.id` stamps applied. */
function stampedRunScript(emit: (event: HostEvent) => void): void {
  const run = makeSpan('s-run', 'invoke_agent test-agent', {
    [GenAiAttr.OPERATION_NAME]: GenAiOperation.INVOKE_AGENT,
    [SdkAttr.NODE_ID]: 'agent',
  });
  const chat = makeSpan('s-chat', 'chat mock-1', {
    [GenAiAttr.OPERATION_NAME]: GenAiOperation.CHAT,
    [SdkAttr.NODE_ID]: 'agent',
  }, 's-run');
  const unstamped = makeSpan('s-unstamped', 'execute_tool unstamped', {
    [GenAiAttr.OPERATION_NAME]: GenAiOperation.EXECUTE_TOOL,
  }, 's-run');
  const tool = makeSpan('s-tool', 'execute_tool current_date', {
    [GenAiAttr.OPERATION_NAME]: GenAiOperation.EXECUTE_TOOL,
    [SdkAttr.NODE_ID]: 'tool:current_date',
  }, 's-run');
  const wait = makeSpan('s-wait', `${APPROVAL_WAIT_SPAN_NAME} send_email`, {
    [SdkAttr.NODE_ID]: 'tool:send_email',
    [SdkAttr.APPROVAL_ID]: 'appr-1',
    [SdkAttr.APPROVAL_KIND]: 'tool',
    [GenAiAttr.TOOL_NAME]: 'send_email',
  }, 's-run');
  const badTool = makeSpan('s-bad', 'execute_tool failing_tool', {
    [GenAiAttr.OPERATION_NAME]: GenAiOperation.EXECUTE_TOOL,
    [SdkAttr.NODE_ID]: 'tool:failing_tool',
  }, 's-run');

  const start = (span: Span) => emit({ type: 'span', phase: 'start', span });
  const end = (span: Span, status?: Span['status']) =>
    emit({ type: 'span', phase: 'end', span: { ...span, endTime: Date.now(), ...(status && { status }) } });

  start(run);
  start(chat);
  end(chat);
  start(unstamped);
  end(unstamped);
  start(tool);
  end(tool);
  start(wait);
  end(wait);
  start(badTool);
  end(badTool, { code: 'error', message: 'boom' });
  end(run);
}

function makeRunManager(baseDir: string, host: AgentHost): RunManager {
  return new RunManager({
    baseDir,
    checkpointStore: new FileCheckpointStore(baseDir),
    approvalStore: new FileApprovalStore(baseDir),
    host,
    loadSpec: async () => undefined,
    saveSpec: async () => {},
  });
}

describe('RunManager node status frames', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-node-test-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('emits one running/waiting frame then one done/error frame per node-carrying span, in order', async () => {
    const runManager = makeRunManager(baseDir, new ScriptedHost(stampedRunScript));
    const frames: NodeStatePayload[] = [];
    runManager.on('node', (agentId: string, payload: NodeStatePayload) => {
      if (agentId === 'node-agent') frames.push(payload);
    });

    await runManager.run('node-agent', 'go', SPEC);
    await waitForStatus(runManager, 'node-agent', (s) => s.status === 'done');

    expect(frames.map((f) => [f.nodeId, f.state])).toEqual([
      ['agent', 'running'],
      ['agent', 'running'], // the chat span also maps to the agent node
      ['agent', 'done'],
      ['tool:current_date', 'running'],
      ['tool:current_date', 'done'],
      ['tool:send_email', 'waiting'], // the approval.wait marker - and NO done after it (zero-length marker ends emit no node frame)
      ['tool:failing_tool', 'running'],
      ['tool:failing_tool', 'error'],
      ['agent', 'done'],
    ]);
    // The unstamped span produced no frame at all.
    expect(frames.every((f) => f.spanId !== 's-unstamped')).toBe(true);
    // Every frame is ids/state/ISO-time only.
    for (const frame of frames) {
      expect(typeof frame.spanId).toBe('string');
      expect(frame.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(Object.keys(frame).sort()).toEqual(['at', 'nodeId', 'spanId', 'state']);
    }
  });

  it('a node frame arrives on WS /agents/:id/stream', async () => {
    const runManager = makeRunManager(baseDir, new ScriptedHost(stampedRunScript));
    const server = http.createServer();
    const wss = attachWebSocketServer(createUpgradeRouter(server), runManager);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agents/ws-agent/stream`);
    const nodes: NodeStatePayload[] = [];
    const spanIds: string[] = [];
    try {
      ws.on('message', (data) => {
        const message = JSON.parse(String(data));
        if (message.type === 'node') nodes.push(message.payload);
        if (message.type === 'span') spanIds.push(message.payload.id);
      });
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      await runManager.run('ws-agent', 'go', SPEC);
      await waitForStatus(runManager, 'ws-agent', (s) => s.status === 'done');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes[0]).toMatchObject({ nodeId: 'agent', state: 'running', spanId: 's-run' });
      // A node frame always follows the `span` frame it was derived from.
      for (const frame of nodes) expect(spanIds).toContain(frame.spanId);
      expect(nodes.some((f) => f.nodeId === 'tool:send_email' && f.state === 'waiting')).toBe(true);
    } finally {
      ws.close();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('a real mock-provider run through the in-process host emits node frames end to end', async () => {
    // buildAgentV2 wraps the run's exporter in the SDK's nodeIdExporter
    // (specV2ToAgent's S20 wiring), so the run's spans carry
    // `lousho.node.id` and RunManager derives `node` frames from them -
    // the canvas overlay's whole feed. 'please use current_date' makes
    // the mock provider call the current_date tool, so both the agent
    // node and the tool node light up.
    const runManager = makeRunManager(baseDir, newTestHost(baseDir));
    const frames: NodeStatePayload[] = [];
    runManager.on('node', (agentId: string, payload: NodeStatePayload) => {
      if (agentId === 'mock-agent') frames.push(payload);
    });

    await runManager.run('mock-agent', 'please use current_date', SPEC);
    await waitForStatus(runManager, 'mock-agent', (s) => s.status === 'done');

    const sequence = frames.map((f) => [f.nodeId, f.state]);
    expect(sequence).toContainEqual(['agent', 'running']);
    expect(sequence).toContainEqual(['tool:current_date', 'running']);
    expect(sequence).toContainEqual(['tool:current_date', 'done']);
    expect(sequence[sequence.length - 1]).toEqual(['agent', 'done']);
    // Only §3.3 node ids the spec declares - never span names or args.
    expect(frames.every((f) => f.nodeId === 'agent' || f.nodeId === 'tool:current_date')).toBe(true);
  });
});
