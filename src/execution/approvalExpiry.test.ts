/**
 * TTL: a pause for approval carries `expiresAt` (from the run's
 * `approvalTtlMs`, or an `ask` rule's `ttlMs`); decided after it - through
 * `resumeAfterApproval()`, from any process over a shared store - the call
 * is denied with reason 'approval expired' instead of running stale.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Tool } from 'ai';
import { resumeAfterApproval } from './resume';
import { approvalExpired, type ApprovalStore, type ExecutionSnapshot, type PendingApproval } from './ApprovalGate';
import { AgentExecutor } from './AgentExecutor';
import { APPROVAL_EXPIRED_REASON } from './permissions';
import { ask } from './permissions';
import { createMockProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';

/** Simple in-memory ApprovalStore, as resume.test.ts uses. */
function createInMemoryApprovalStore(): ApprovalStore {
  const records = new Map<string, { pending: PendingApproval; snapshot: ExecutionSnapshot }>();
  return {
    async save(pending, snapshot) {
      records.set(pending.id, { pending, snapshot });
    },
    async resolve(id) {
      const record = records.get(id);
      if (!record) return null;
      records.delete(id);
      return record;
    },
    async load(id) {
      return records.get(id) ?? null;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('approvalExpired', () => {
  it('is false without expiresAt, true past it, false before it', () => {
    expect(approvalExpired({})).toBe(false);
    expect(approvalExpired({ expiresAt: new Date(Date.now() - 1).toISOString() })).toBe(true);
    expect(approvalExpired({ expiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
    expect(approvalExpired({ expiresAt: 'not a date' })).toBe(false);
  });
});

describe('Execution - approval expiry (TTL)', () => {
  let toolRegistry: ToolRegistry;
  let execute: ReturnType<typeof vi.fn>;

  const agent = () =>
    AgentBuilder.create()
      .setName('Test Agent')
      .addTool('chargeCard', { tool: 'chargeCard', options: {} })
      .build();

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    execute = vi.fn().mockResolvedValue({ charged: true });
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute } as Tool,
      needsApproval: true,
    });
  });

  it('stamps expiresAt on the pause and a decision before it still runs the tool', async () => {
    const approvalStore = createInMemoryApprovalStore();
    const provider = createMockProvider({ name: 'mock', responses: ['Charging now', 'All done'] });

    const paused = await AgentExecutor.execute({
      agent: agent(),
      input: 'Please call chargeCard now',
      provider,
      toolRegistry,
      approvalStore,
      approvalTtlMs: 60_000,
    });

    expect(paused.finishReason).toBe('awaiting-approval');
    const pending = (await approvalStore.load?.(paused.approvalId!))?.pending;
    expect(pending?.expiresAt).toBeDefined();
    expect(Date.parse(pending!.expiresAt!) - Date.now()).toBeGreaterThan(0);

    const resumed = await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, toolRegistry, provider);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(resumed.finishReason).toBe('stop');
  });

  it('denies a decision that arrives after expiresAt - even approved: true', async () => {
    const approvalStore = createInMemoryApprovalStore();
    const provider = createMockProvider({ name: 'mock', responses: ['Charging now', 'All done'] });

    const paused = await AgentExecutor.execute({
      agent: agent(),
      input: 'Please call chargeCard now',
      provider,
      toolRegistry,
      approvalStore,
      approvalTtlMs: 30,
    });
    const pending = (await approvalStore.load?.(paused.approvalId!))?.pending;
    await sleep(50);

    const resumed = await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, toolRegistry, provider);

    expect(execute).not.toHaveBeenCalled();
    expect(resumed.finishReason).toBe('stop');
    const denial = resumed.messages.find((m) => m.role === 'tool' && m.toolCallId === pending?.toolCallId);
    expect(denial?.isError).toBe(true);
    expect(JSON.parse(denial!.content as string)).toMatchObject({
      error: 'ToolDeniedError',
      toolName: 'chargeCard',
      kind: 'denied',
      message: expect.stringContaining('expired'),
    });
  });

  it('audits the expiry as a deny decision with reason "approval expired"', async () => {
    const approvalStore = createInMemoryApprovalStore();
    const onPermissionDecision = vi.fn();
    const provider = createMockProvider({ name: 'mock', responses: ['Charging now', 'All done'] });

    const paused = await AgentExecutor.execute({
      agent: agent(),
      input: 'Please call chargeCard now',
      provider,
      toolRegistry,
      approvalStore,
      approvalTtlMs: 30,
      onPermissionDecision,
    });
    await sleep(50);

    await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, toolRegistry, provider, {
      onPermissionDecision,
    });

    expect(onPermissionDecision).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'chargeCard', decision: 'deny', reason: APPROVAL_EXPIRED_REASON }),
      expect.anything()
    );
  });

  it("an `ask` rule's ttlMs bounds the pause and wins over the run's approvalTtlMs", async () => {
    toolRegistry = new ToolRegistry();
    execute = vi.fn().mockResolvedValue({ charged: true });
    // No needsApproval: the `ask` rule pauses the call.
    toolRegistry.register('chargeCard', {
      displayName: 'Charge Card',
      tool: { description: 'Charge a card', parameters: {}, execute } as Tool,
    });
    const approvalStore = createInMemoryApprovalStore();
    const provider = createMockProvider({ name: 'mock', responses: ['Charging now', 'All done'] });

    const paused = await AgentExecutor.execute({
      agent: agent(),
      input: 'Please call chargeCard now',
      provider,
      toolRegistry,
      approvalStore,
      approvalTtlMs: 60_000,
      permissions: [ask('chargeCard', { ttlMs: 30 })],
    });

    expect(paused.finishReason).toBe('awaiting-approval');
    const pending = (await approvalStore.load?.(paused.approvalId!))?.pending;
    expect(Date.parse(pending!.expiresAt!)).toBeLessThanOrEqual(Date.now() + 60_000);
    await sleep(50);

    const resumed = await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, toolRegistry, provider);
    expect(execute).not.toHaveBeenCalled();
    expect(resumed.finishReason).toBe('stop');
  });

  it('leaves a pause without approvalTtlMs undated and decidable at any time', async () => {
    const approvalStore = createInMemoryApprovalStore();
    const provider = createMockProvider({ name: 'mock', responses: ['Charging now', 'All done'] });

    const paused = await AgentExecutor.execute({
      agent: agent(),
      input: 'Please call chargeCard now',
      provider,
      toolRegistry,
      approvalStore,
    });

    const pending = (await approvalStore.load?.(paused.approvalId!))?.pending;
    expect(pending?.expiresAt).toBeUndefined();

    const resumed = await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, toolRegistry, provider);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(resumed.finishReason).toBe('stop');
  });
});
