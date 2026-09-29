/**
 * Exercises the exact approval-gate pause/resume machinery
 * RunManager.approve() (runRegistry.ts) drives - AgentExecutor.execute()
 * pausing on a tool that needs approval, FileApprovalStore persisting the
 * pending decision, and resumeAfterApproval() continuing the run - using
 * the public SDK API directly. RunManager itself only wires these together
 * (buildAgentFromSpec + a thin dispatch), so this is where the actual
 * pause -> approve -> resume round trip is verified; runRegistry.test.ts and
 * app.test.ts cover the run()/stop() and HTTP-layer behavior around it.
 *
 * None of the LOU-N server's spec-resolvable tools (http/current-date/
 * day-name, see buildAgent.ts + specToAgent.ts's RESOLVABLE_BUILT_IN_TOOLS)
 * set `needsApproval`, so a spec alone can't trigger this path end-to-end
 * through the HTTP API in a test - a custom ToolDescriptor is used here
 * instead, exactly mirroring what a real approval-gated tool would do.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  AgentExecutor,
  ToolRegistry,
  AgentBuilder,
  AgentType,
  createMockProvider,
  resumeAfterApproval,
  type ToolDescriptor,
} from '@loushy/build-ai-agent';
import { FileApprovalStore } from '../approvalStore';
import { FileCheckpointStore } from '../checkpointStore';

describe('approval-gate pause/resume (FileApprovalStore + FileCheckpointStore)', () => {
  let baseDir: string;
  let approvalStore: FileApprovalStore;
  let checkpointStore: FileCheckpointStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-n-approval-test-'));
    approvalStore = new FileApprovalStore(baseDir);
    checkpointStore = new FileCheckpointStore(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function buildGatedAgentConfig(agentId: string) {
    const dangerousTool: ToolDescriptor = {
      displayName: 'Dangerous Tool',
      tool: {
        description: 'Does something dangerous',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ done: true }),
      } as any,
      needsApproval: true,
    };
    const toolRegistry = new ToolRegistry();
    toolRegistry.register('dangerous', dangerousTool);

    const provider = createMockProvider({
      name: 'mock',
      responses: ['calling the dangerous tool', 'all done'],
    });

    const agent = AgentBuilder.create()
      .setId(agentId)
      .setType(AgentType.SmartAssistant)
      .setName('gated-agent')
      .setPrompt('You are a helpful agent.')
      .setTools({ dangerous: { tool: 'dangerous' } })
      .build();

    return { agent, provider, toolRegistry };
  }

  it('pauses on a needsApproval tool, persists the pending decision, and resumes on approve', async () => {
    const agentId = 'gated-agent-1';
    const { agent, provider, toolRegistry } = buildGatedAgentConfig(agentId);

    const paused = await AgentExecutor.execute({
      agent,
      input: 'please call the dangerous tool',
      provider,
      toolRegistry,
      approvalStore,
      sessionId: agentId,
      checkpointStore,
    });

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.approvalId).toBeTruthy();

    // Exactly what runRegistry.ts's handleRunSettled() reads to build the
    // UI's pending-approval card.
    const record = await approvalStore.peek(agentId, paused.approvalId!);
    expect(record?.pending.toolName).toBe('dangerous');

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      provider,
      {},
      checkpointStore
    );

    expect(resumed.finishReason).not.toBe('awaiting-approval');
    expect(resumed.text).toBeTruthy();

    // The approval record is delete-on-read.
    expect(await approvalStore.peek(agentId, paused.approvalId!)).toBeNull();
  });

  it('a rejected approval resumes the run with a rejection tool-result instead of executing the tool', async () => {
    const agentId = 'gated-agent-2';
    const { agent, provider, toolRegistry } = buildGatedAgentConfig(agentId);

    const paused = await AgentExecutor.execute({
      agent,
      input: 'please call the dangerous tool',
      provider,
      toolRegistry,
      approvalStore,
      sessionId: agentId,
      checkpointStore,
    });
    expect(paused.finishReason).toBe('awaiting-approval');

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: false, note: 'not today' },
      approvalStore,
      toolRegistry,
      provider,
      {},
      checkpointStore
    );

    const toolMessage = resumed.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('rejected');
  });
});
