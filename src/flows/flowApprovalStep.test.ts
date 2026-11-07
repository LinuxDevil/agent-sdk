/**
 * An `approval` step is a human gate of its own: it asks the context's
 * `approve` callback, or pauses a durable run until `FlowExecutor.resume()`
 * brings the decision - exactly as a `toolCall` that needs approval does.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { AgentFlow } from '../types/flow';
import { FlowExecutor, type FlowExecutionContext, type FlowResumeContext } from './FlowExecutor';
import { MockLLMProvider } from '../providers/mock';
import { memoryStore } from '../storage/agentStore';
import type { CheckpointStore } from '../execution/checkpoint';
import type { PendingApproval } from '../execution/ApprovalGate';

const flow: AgentFlow = {
  code: 'release',
  name: 'Release',
  flow: {
    type: 'sequence',
    steps: [
      { type: 'approval', id: 'ship-gate', message: 'Ship {{version}} to production?', outputVariable: 'approved' },
      { type: 'return', value: '$approved' },
    ],
  },
};

describe('FlowExecutor approval step', () => {
  let provider: MockLLMProvider;
  let store: CheckpointStore;
  let approve: Mock;
  let context: FlowExecutionContext;
  let resumeContext: FlowResumeContext;

  beforeEach(() => {
    provider = new MockLLMProvider({ name: 'mock', responses: ['unused'] });
    approve = vi.fn(() => true);
    store = memoryStore().checkpoints;
    context = {
      agent: { name: 'flow-agent' },
      provider,
      variables: { version: '2.1' },
      approve,
      checkpointStore: store,
      runId: 'release-1',
    };
    const { variables: _v, checkpointStore: _s, runId: _r, ...rest } = context;
    resumeContext = { ...rest, checkpointStore: store, runId: 'release-1' };
  });

  it('asks approve with a flow_approval request and continues on approval', async () => {
    const { checkpointStore: _s, runId: _r, ...plain } = context;
    const result = await FlowExecutor.execute(flow, plain);

    expect(result).toMatchObject({ status: 'completed', success: true, output: true });
    expect(result.variables.approved).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    const request = approve.mock.calls[0][0] as PendingApproval;
    expect(request).toMatchObject({
      toolCallId: request.id,
      toolName: 'flow_approval',
      args: { message: 'Ship 2.1 to production?', stepId: 'ship-gate' },
    });
  });

  it('fails with LOUSHO_FLOW_TOOL_DENIED naming the step when approve rejects', async () => {
    approve.mockReturnValue(false);
    const { checkpointStore: _s, runId: _r, ...plain } = context;

    const result = await FlowExecutor.execute(flow, plain);

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'LOUSHO_FLOW_TOOL_DENIED' });
    expect(result.error?.message).toMatch(/^Approval step 'ship-gate'/);
  });

  it('fails closed without an approve callback in a non-durable run', async () => {
    const { checkpointStore: _s, runId: _r, approve: _a, ...plain } = context;

    const result = await FlowExecutor.execute(flow, plain);

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'LOUSHO_FLOW_TOOL_DENIED' });
    expect(result.error?.message).toMatch(/^Approval step 'ship-gate'/);
  });

  it('pauses a durable run without approve; resume approves or rejects it', async () => {
    const paused = await FlowExecutor.execute(flow, { ...context, approve: undefined });

    expect(paused.status).toBe('awaiting-approval');
    expect(paused.error).toBeUndefined();
    expect(paused.pendingApproval).toEqual({
      approvalId: paused.approvalId,
      nodeId: '0.0',
      toolName: 'flow_approval',
      args: { message: 'Ship 2.1 to production?', stepId: 'ship-gate' },
    });
    expect((await store.load('release-1'))?.status).toBe('awaiting-approval');

    const approved = await FlowExecutor.resume(flow, {
      ...resumeContext,
      approval: { approvalId: paused.approvalId!, approved: true },
    });
    expect(approved).toMatchObject({ status: 'completed', success: true, output: true });
    expect((await store.load('release-1'))?.status).toBe('finished');

    // A fresh run pauses the same way, and a rejection fails the step.
    const second = await FlowExecutor.execute(flow, { ...context, approve: undefined, runId: 'release-2' });
    const rejected = await FlowExecutor.resume(flow, {
      ...resumeContext,
      runId: 'release-2',
      approval: { approvalId: second.approvalId!, approved: false },
    });
    expect(rejected.status).toBe('failed');
    expect(rejected.error).toMatchObject({ code: 'LOUSHO_FLOW_TOOL_DENIED' });
  });

  it("pauses a durable run on 'defer', fails a non-durable one", async () => {
    approve.mockReturnValue('defer');

    const paused = await FlowExecutor.execute(flow, context);
    expect(paused.status).toBe('awaiting-approval');
    expect(paused.pendingApproval?.toolName).toBe('flow_approval');

    const { checkpointStore: _s, runId: _r, ...plain } = context;
    const refused = await FlowExecutor.execute(flow, plain);
    expect(refused.status).toBe('failed');
    expect(refused.error).toMatchObject({ code: 'LOUSHO_FLOW_TOOL_DENIED' });
    expect(refused.error?.message).toMatch(/^Approval step 'ship-gate'/);
  });
});
