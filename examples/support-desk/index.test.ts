import { describe, expect, it, vi } from 'vitest';
import { mockModel, type MockModel } from '../../src/testing';
import { createSupportDesk, demoState, scriptedBilling, scriptedTriage } from './index';

const toolNames = (model: MockModel, call: number) => (model.calls[call]?.tools ?? []).map((tool) => tool.function.name);

describe('examples/support-desk', () => {
  it('triage hands the whole conversation to billing; billing answers, and the refund write needed approval', async () => {
    const state = demoState();
    const triage = scriptedTriage();
    const billing = mockModel([
      { toolCalls: [{ name: 'lookup_order', args: { orderId: 'A-10042' } }] },
      { toolCalls: [{ name: 'issue_refund', args: { orderId: 'A-10042', amountCents: 2599, reason: 'broken' } }] },
      { text: 'Refunded $25.99 for order A-10042.' },
    ]);
    const onHandoff = vi.fn();
    const approve = vi.fn(async () => true);
    const desk = createSupportDesk({ state, triageProvider: triage, billingProvider: billing, techProvider: mockModel([]), onHandoff, approve });

    const result = await desk.agent.send('My order A-10042 arrived broken - refund me.');

    // (a) the handoff tool was offered and called, with structured routing args
    expect(toolNames(triage, 0)).toEqual(['transfer_to_billing', 'transfer_to_techSupport']);
    expect(onHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'triage', to: 'billing', args: { reason: 'Order arrived broken; customer wants a refund', orderId: 'A-10042' } })
    );
    expect(desk.handoffsSeen).toEqual([{ from: 'triage', to: 'billing', args: { reason: 'Order arrived broken; customer wants a refund', orderId: 'A-10042' } }]);

    // (b) the billing agent answered the turn, with its own prompt and tools
    expect(result.agentName).toBe('billing');
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Refunded $25.99 for order A-10042.');
    expect(triage.calls).toHaveLength(1);
    expect(billing.calls).toHaveLength(3);
    expect(toolNames(billing, 0)).toEqual(['lookup_order', 'issue_refund', 'transfer_to_triage']);
    // the filtered transcript: triage's tool noise is gone, the routing note carried the args
    const seen = billing.calls[0].messages;
    expect(seen.some((m) => m.role === 'tool')).toBe(false);
    expect(String(seen.at(-1)?.content)).toContain('orderId="A-10042"');

    // (c) the refund write tool required approval, then ran
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'issue_refund', args: expect.objectContaining({ orderId: 'A-10042' }) }));
    expect(state.refunds).toEqual([{ refundId: 'R-1000', orderId: 'A-10042', amountCents: 2599, reason: 'broken' }]);
  });

  it('without an approver the run pauses on issue_refund; approvals.resolve() continues it as billing', async () => {
    const state = demoState();
    const billing = mockModel([
      { toolCalls: [{ name: 'lookup_order', args: { orderId: 'A-10042' } }] },
      { toolCalls: [{ name: 'issue_refund', args: { orderId: 'A-10042', amountCents: 2599, reason: 'broken' } }] },
      { text: 'Refund issued.' },
    ]);
    const desk = createSupportDesk({ state, triageProvider: scriptedTriage(), billingProvider: billing, techProvider: mockModel([]) });

    const paused = await desk.agent.send('Refund order A-10042, it arrived broken.');

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.agentName).toBe('billing'); // paused inside the specialist's turn
    expect(state.refunds).toHaveLength(0);
    expect((await desk.agent.approvals.list()).map((p) => p.toolName)).toEqual(['issue_refund']);

    const done = await desk.agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(done.finishReason).toBe('stop');
    expect(done.agentName).toBe('billing'); // the resumed run is still the specialist's
    expect(done.text).toBe('Refund issued.');
    expect(state.refunds).toHaveLength(1);
    expect(billing.calls).toHaveLength(3);
  });

  it('the specialist owns later session turns: the follow-up goes straight to billing', async () => {
    const state = demoState();
    const triage = scriptedTriage();
    const billing = scriptedBilling();
    const desk = createSupportDesk({
      state,
      triageProvider: triage,
      billingProvider: billing,
      techProvider: mockModel([]),
      approve: async () => true,
    });
    const session = desk.agent.session();

    await session.send('My order A-10042 arrived broken - refund me.');
    const second = await session.send('Thanks! Roughly when will the money land?');

    expect(second.agentName).toBe('billing');
    expect(second.text).toContain('business days');
    expect(triage.calls).toHaveLength(1); // triage never re-entered
    expect(billing.calls).toHaveLength(4);
  });

  it('routes device problems to techSupport', async () => {
    const tech = mockModel([
      { toolCalls: [{ name: 'run_diagnostics', args: { device: 'wifi router' } }] },
      { text: 'Your router firmware is behind - update it via the app.' },
    ]);
    const desk = createSupportDesk({
      state: demoState(),
      triageProvider: mockModel([{ toolCalls: [{ name: 'transfer_to_techSupport', args: { reason: 'wifi keeps dropping' } }] }]),
      billingProvider: mockModel([]),
      techProvider: tech,
    });

    const result = await desk.agent.send('My wifi router keeps dropping the connection.');

    expect(result.agentName).toBe('techSupport');
    expect(tech.calls).toHaveLength(2);
    expect(result.text).toContain('firmware');
  });

  it('a specialist can hand the conversation back to triage', async () => {
    const triage = mockModel([
      { toolCalls: [{ name: 'transfer_to_billing', args: { reason: 'sounds like money', orderId: 'A-10042' } }] },
      { text: 'Back at the front desk - that is a sales question, let me help.' },
    ]);
    const billing = mockModel([
      { toolCalls: [{ name: 'transfer_to_triage', args: { reason: 'plan upgrades are not billing' } }] },
    ]);
    const desk = createSupportDesk({ state: demoState(), triageProvider: triage, billingProvider: billing, techProvider: mockModel([]) });

    const result = await desk.agent.send('I want to upgrade my plan - what does the pro tier cost?');

    expect(result.agentName).toBe('triage');
    expect(result.text).toContain('front desk');
    expect(desk.handoffsSeen.map((h) => `${h.from}->${h.to}`)).toEqual(['triage->billing', 'billing->triage']);
  });

  it('handoff arguments that fail the input schema become a tool error - no handoff', async () => {
    const billing = mockModel([]);
    const triage = mockModel([
      { toolCalls: [{ name: 'transfer_to_billing', args: { orderId: 'A-10042' } }] }, // missing required `reason`
      { text: 'I could not route you; let me help myself.' },
    ]);
    const desk = createSupportDesk({ state: demoState(), triageProvider: triage, billingProvider: billing, techProvider: mockModel([]) });

    const result = await desk.agent.send('Refund me please.');

    expect(result.agentName).toBe('triage');
    expect(result.text).toContain('help myself');
    expect(billing.calls).toHaveLength(0);
    expect(desk.handoffsSeen).toHaveLength(0);
  });
});
