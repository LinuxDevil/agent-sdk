/**
 * S3 (LOU-S): covers `buildAgent.ts`'s `demo-approval` local tool - the one
 * addition that makes a real human-in-the-loop approval gate reachable
 * through the actual app (create an agent, add a "Tool call" node named
 * `demo-approval`, run it) rather than only via a hand-built ToolDescriptor
 * in a unit test (see `approvalFlow.test.ts`'s doc comment). The Playwright
 * E2E smoke test (`e2e/studio.spec.ts`) exercises this same tool through
 * the real browser UI end to end; this is the fast, server-only check that
 * the pause/resume machinery actually engages for it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentSpec } from '@loushy/build-ai-agent';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';

const GATED_SPEC: AgentSpec = {
  name: 'gated-test-agent',
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
  tools: ['demo-approval'],
};

function waitForStatus(
  runManager: RunManager,
  agentId: string,
  predicate: (status: { status: string }) => boolean,
  timeoutMs = 2000
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
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

describe("buildAgentFromSpec's local 'demo-approval' tool", () => {
  let baseDir: string;
  let runManager: RunManager;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-s-local-tool-test-'));
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

  it('pauses awaiting approval when the mock provider calls it, and completes once approved', async () => {
    const agentId = 'gated-agent';
    await runManager.run(agentId, 'please use demo-approval', GATED_SPEC);

    const paused = await waitForStatus(runManager, agentId, (s) => s.status === 'paused');
    expect(paused.reason).toBe('awaiting_approval');
    expect(paused.pendingApproval?.toolName).toBe('demo-approval');

    await runManager.approve(agentId, paused.pendingApproval.approvalId, true);
    const final = await waitForStatus(runManager, agentId, (s) => s.status === 'stopped');
    expect(final.status).toBe('stopped');
  });
});
