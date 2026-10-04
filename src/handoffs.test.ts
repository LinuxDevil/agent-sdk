/**
 * N6: handoffs. A triage agent hands the conversation to a specialist, which
 * answers in the same run and keeps the conversation in later session turns.
 * One mockModel per agent, so each test sees which agent made each model call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent, type SimpleAgent } from './createAgent';
import { handoff, handoffFilters, type Handoff } from './handoffs';
import { defineTool } from './tools/defineTool';
import { once } from './tools/approvalPolicies';
import { deny } from './execution/permissions';
import { PropagatingToolError } from './execution/propagatingToolError';
import { remoteAgent } from './subagents/remoteAgent';
import { memoryStore } from './storage/agentStore';
import { mockModel, type MockModel } from './testing';
import type { AgentEvent } from './execution/agentEvents';
import type { Message } from './providers';
import type { HandoffInputData } from './execution/handoffRun';

const toBilling = (args: Record<string, unknown> = { reason: 'billing question' }, id = 'call_handoff') => ({ toolCalls: [{ name: 'transfer_to_billing', args, id }] });

function lookupTool() {
  return defineTool({ name: 'lookup_account', description: 'Looks up the account', input: z.object({}), execute: async () => ({ plan: 'pro' }) });
}

function refundTool(options: { needsApproval?: boolean; crash?: { once: boolean } } = {}) {
  const execute = vi.fn(async ({ amount }: { amount: number }, ctx?: { principal?: { id: string } }) => {
    if (options.crash?.once) {
      options.crash.once = false;
      throw new PropagatingToolError('process died while refunding');
    }
    return { refunded: amount, for: ctx?.principal?.id ?? null };
  });
  const tool = defineTool({ name: 'refund', description: 'Refunds a charge', input: z.object({ amount: z.number() }), needsApproval: options.needsApproval, execute });
  return { tool, execute };
}

/** A billing specialist and a triage agent that hands off to it. */
function setup(
  triageScript: Parameters<typeof mockModel>[0],
  billingScript: Parameters<typeof mockModel>[0],
  options: {
    triage?: Partial<Parameters<typeof createAgent>[0]>;
    billing?: Partial<Parameters<typeof createAgent>[0]>;
    entry?: (billing: SimpleAgent) => SimpleAgent | Handoff;
    refund?: ReturnType<typeof refundTool>;
  } = {}
) {
  const triageModel = mockModel(triageScript);
  const billingModel = mockModel(billingScript);
  const refund = options.refund ?? refundTool();
  const billing = createAgent({
    name: 'billing',
    description: 'Answers billing questions',
    instructions: 'You handle billing.',
    provider: billingModel,
    tools: [refund.tool],
    ...options.billing,
  } as Parameters<typeof createAgent>[0]);
  const triage = createAgent({
    name: 'triage',
    description: 'Routes the user',
    instructions: 'You route the user.',
    provider: triageModel,
    tools: [lookupTool()],
    handoffs: [options.entry ? options.entry(billing) : billing],
    ...options.triage,
  } as Parameters<typeof createAgent>[0]);
  return { triage, billing, triageModel, billingModel, refund };
}

const toolNames = (model: MockModel, call: number) => (model.calls[call].tools ?? []).map((tool) => tool.function.name);
const systemPrompts = (messages: readonly Message[]) => messages.filter((m) => m.role === 'system').map((m) => m.content);
const handoffResult = (messages: readonly Message[]) => messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_handoff');

afterEach(() => { vi.restoreAllMocks(); });

describe('handoffs (N6): send() and stream()', () => {
  it('send(): the target answers in the same run with its own prompt, model and tools; result.agentName names it', async () => {
    const { triage, triageModel, billingModel } = setup([toBilling()], ['Your refund is on its way.']);

    const result = await triage.send('I was charged twice');

    expect(result.text).toBe('Your refund is on its way.');
    expect(result.agentName).toBe('billing');
    expect(result.finishReason).toBe('stop');
    expect(triageModel.calls).toHaveLength(1);
    expect(billingModel.calls).toHaveLength(1);
    // The lead offered its tools and the handoff; the target offers its own tools only.
    expect(toolNames(triageModel, 0)).toEqual(['lookup_account', 'transfer_to_billing']);
    expect(toolNames(billingModel, 0)).toEqual(['refund']);
    // One system prompt, the target's, never both.
    expect(systemPrompts(billingModel.calls[0].messages as Message[])).toEqual(['You handle billing.']);
    const marker = handoffResult(result.messages);
    expect(JSON.parse(marker?.content as string)).toEqual({ transferred_to: 'billing' });
    expect(marker?.metadata?.handoff).toEqual({ from: 'triage', to: 'billing' });
    expect(result.steps).toBe(2);
  });

  it('a run without a handoff call keeps result.agentName as the lead', async () => {
    const { triage } = setup(['Hello! How can I help?'], []);
    const result = await triage.send('Hi');
    expect(result.agentName).toBe('triage');
  });

  it('stream(): tool.start of the handoff, its tool.done, handoff, then the target steps; one run.start and one run.done', async () => {
    const { triage } = setup([toBilling()], ['Refunded.']);
    const events: AgentEvent[] = [];
    const run = triage.stream('I was charged twice');
    for await (const event of run) events.push(event);
    const types = events.map((event) => event.type);

    expect(types.filter((type) => type === 'run.start')).toHaveLength(1);
    expect(types.filter((type) => type === 'run.done')).toHaveLength(1);
    const handoffEvent = events.find((event) => event.type === 'handoff');
    expect(handoffEvent).toMatchObject({ from: 'triage', to: 'billing', toolCallId: 'call_handoff' });
    const start = events.findIndex((event) => event.type === 'tool.start' && event.toolCallId === 'call_handoff');
    const done = events.findIndex((event) => event.type === 'tool.done' && event.toolCallId === 'call_handoff');
    const at = events.indexOf(handoffEvent as AgentEvent);
    const targetStep = events.findIndex((event) => event.type === 'step.start' && event.step === 2);
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(done);
    expect(done).toBeLessThan(at);
    expect(at).toBeLessThan(targetStep);
    expect((await run.result).agentName).toBe('billing');
  });

  it('the other tool calls of the step run as usual, before the handoff', async () => {
    const turn = { toolCalls: [{ name: 'lookup_account', args: {}, id: 'call_lookup' }, { name: 'transfer_to_billing', args: {}, id: 'call_handoff' }] };
    const { triage, billingModel } = setup([turn], ['Done.']);

    const result = await triage.send('Refund me');

    const seen = billingModel.calls[0].messages as Message[];
    const results = seen.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
    expect(results).toEqual(['call_lookup', 'call_handoff']);
    expect(JSON.parse(seen.find((m) => m.toolCallId === 'call_lookup')?.content as string)).toEqual({ plan: 'pro' });
    expect(result.agentName).toBe('billing');
  });
});

describe('handoffs (N6): options', () => {
  it('inputFilter gets the transcript without the system prompt, ending with the handoff call and its result', async () => {
    let seen: HandoffInputData | undefined;
    const onHandoff = vi.fn();
    const { triage, billingModel } = setup([toBilling({ reason: 'double charge' })], ['OK.'], {
      entry: (billing) =>
        handoff(billing, {
          inputFilter: (data) => {
            seen = data;
            return data.messages;
          },
          onHandoff,
        }),
    });

    await triage.send('I was charged twice', { sessionId: undefined });

    expect(seen?.from).toBe('triage');
    expect(seen?.to).toBe('billing');
    expect(seen?.args).toEqual({ reason: 'double charge' });
    expect(seen?.messages[0]).toMatchObject({ role: 'user', content: 'I was charged twice' });
    expect(seen?.messages.at(-2)?.toolCalls?.[0].id).toBe('call_handoff');
    expect(seen?.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_handoff' });
    expect(onHandoff).toHaveBeenCalledWith(expect.objectContaining({ from: 'triage', to: 'billing', args: { reason: 'double charge' } }));
    expect(billingModel.calls).toHaveLength(1);
  });

  it('handoffFilters.removeToolCalls: the target sees user and assistant text only; the marker moves to the last message', async () => {
    const turn = { text: 'Let me get billing.', toolCalls: [{ name: 'lookup_account', args: {}, id: 'call_lookup' }, { name: 'transfer_to_billing', args: {}, id: 'call_handoff' }] };
    const { triage, billingModel } = setup([turn], ['Billing here.'], { entry: (billing) => handoff(billing, { inputFilter: handoffFilters.removeToolCalls }) });

    const result = await triage.send('I was charged twice');

    const seen = billingModel.calls[0].messages as Message[];
    expect(seen.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(seen[2]).not.toHaveProperty('toolCalls');
    expect(seen[2].content).toBe('Let me get billing.');
    expect(seen[2].metadata?.handoff).toEqual({ from: 'triage', to: 'billing' });
    expect(result.messages.some((m) => m.role === 'tool')).toBe(false);
  });

  it('handoffFilters.lastUserMessage: the target sees only the last user message', async () => {
    const { triage, billingModel } = setup([toBilling()], ['Billing here.'], { entry: (billing) => handoff(billing, { inputFilter: handoffFilters.lastUserMessage }) });

    await triage.send([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'I was charged twice' },
    ]);

    const seen = billingModel.calls[0].messages as Message[];
    expect(seen.map((m) => [m.role, m.content])).toEqual([
      ['system', 'You handle billing.'],
      ['user', 'I was charged twice'],
    ]);
    expect(seen[1].metadata?.handoff).toEqual({ from: 'triage', to: 'billing' });
  });

  it('input: arguments that do not match become a tool error and no handoff happens', async () => {
    const { triage, triageModel, billingModel } = setup([toBilling({}), 'I could not hand you over.'], [], {
      entry: (billing) => handoff(billing, { input: z.object({ reason: z.string() }) }),
    });

    const result = await triage.send('I was charged twice');

    expect(result.agentName).toBe('triage');
    expect(result.text).toBe('I could not hand you over.');
    expect(billingModel.calls).toHaveLength(0);
    expect(triageModel.calls).toHaveLength(2);
    const error = handoffResult(result.messages);
    expect(error?.isError).toBe(true);
    expect(JSON.parse(error?.content as string)).toMatchObject({ error: 'ToolArgumentsValidationError', kind: 'validation' });
    expect(error?.metadata?.handoff).toBeUndefined();
  });

  it('isEnabled: false (or a function of the run returning false) hides the handoff tool', async () => {
    const hidden = setup(['Hi.'], [], { entry: (billing) => handoff(billing, { isEnabled: false }) });
    await hidden.triage.send('Hi');
    expect(toolNames(hidden.triageModel, 0)).toEqual(['lookup_account']);

    const perRun = setup(['Hi.', 'Hi again.'], [], { entry: (billing) => handoff(billing, { isEnabled: ({ metadata }) => metadata?.plan === 'pro' }) });
    await perRun.triage.send('Hi', { metadata: { plan: 'free' } });
    await perRun.triage.send('Hi', { metadata: { plan: 'pro' } });
    expect(toolNames(perRun.triageModel, 0)).toEqual(['lookup_account']);
    expect(toolNames(perRun.triageModel, 1)).toEqual(['lookup_account', 'transfer_to_billing']);
  });

  it('toolName and description options name the tool', async () => {
    const { triage, triageModel } = setup(['Hi.'], [], { entry: (billing) => handoff(billing, { toolName: 'to_billing', description: 'Billing desk' }) });
    await triage.send('Hi');
    const tool = triageModel.calls[0].tools?.find((t) => t.function.name === 'to_billing');
    expect(tool?.function.description).toBe('Billing desk');
  });

  it('two handoffs in one step: the first is honored, the other gets an error result', async () => {
    const refundsModel = mockModel([]);
    const refunds = createAgent({ name: 'refunds', description: 'Refunds', provider: refundsModel });
    const turn = { toolCalls: [{ name: 'transfer_to_billing', args: {}, id: 'call_handoff' }, { name: 'transfer_to_refunds', args: {}, id: 'call_second' }] };
    const billingModel = mockModel(['Billing here.']);
    const billing = createAgent({ name: 'billing', description: 'Billing', provider: billingModel });
    const triage = createAgent({ name: 'triage', provider: mockModel([turn]), handoffs: [billing, refunds] });

    const result = await triage.send('Help');

    expect(result.agentName).toBe('billing');
    expect(refundsModel.calls).toHaveLength(0);
    const second = result.messages.find((m) => m.toolCallId === 'call_second');
    expect(second?.isError).toBe(true);
    expect(JSON.parse(second?.content as string).message).toMatch(/only one handoff per turn/);
    expect(result.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['call_handoff', 'call_second']);
  });

  it('maxHandoffs: a handoff over the limit gets a tool error and the agent answers itself', async () => {
    const backModel = mockModel([{ toolCalls: [{ name: 'transfer_to_triage', args: {}, id: 'call_back' }] }, 'I will answer myself.']);
    const billingHandoffs: Handoff[] = [];
    const billing = createAgent({ name: 'billing', description: 'Billing', provider: backModel, handoffs: billingHandoffs });
    const triageModel = mockModel([toBilling()]);
    const triage = createAgent({ name: 'triage', description: 'Routes the user', provider: triageModel, handoffs: [billing], maxHandoffs: 1 });
    billingHandoffs.push(handoff(triage));

    const result = await triage.send('Help');

    expect(result.agentName).toBe('billing');
    expect(result.text).toBe('I will answer myself.');
    expect(triageModel.calls).toHaveLength(1);
    expect(JSON.parse(result.messages.find((m) => m.toolCallId === 'call_back')?.content as string).message).toMatch(/maxHandoffs/);
  });

  it('maxSteps and limits are the run\'s, counted across agents', async () => {
    const callRefund = { toolCalls: [{ name: 'refund', args: { amount: 5 }, id: 'call_refund' }] };
    const capped = setup([toBilling()], [callRefund, 'unused'], { triage: { maxSteps: 2 } });
    const result = await capped.triage.send('Refund me');
    expect(result.finishReason).toBe('max-steps');
    expect(result.steps).toBe(2);

    const limited = setup([toBilling()], ['unused'], { triage: { limits: { maxSteps: 1 } } });
    const stopped = await limited.triage.send('Refund me');
    expect(stopped.finishReason).toBe('budget-exceeded');
    expect(limited.billingModel.calls).toHaveLength(0);
  });
});

describe('handoffs (N6): what stays the lead run\'s', () => {
  it('the lead\'s permission rules apply to the target\'s tools, before its own', async () => {
    const callRefund = { toolCalls: [{ name: 'refund', args: { amount: 5 }, id: 'call_refund' }] };
    const { triage, refund } = setup([toBilling()], [callRefund, 'No refund possible.'], { triage: { permissions: [deny('refund', 'refunds are off')] } });

    const result = await triage.send('Refund me');

    expect(refund.execute).not.toHaveBeenCalled();
    expect(JSON.parse(result.messages.find((m) => m.toolCallId === 'call_refund')?.content as string)).toMatchObject({ kind: 'denied' });
  });

  it('the target\'s tools act for the run\'s principal', async () => {
    const callRefund = { toolCalls: [{ name: 'refund', args: { amount: 5 }, id: 'call_refund' }] };
    const { triage } = setup([toBilling()], [callRefund, 'Refunded.']);

    const result = await triage.send('Refund me', { principal: { id: 'u-1', type: 'user', authenticator: 'test' } });

    expect(JSON.parse(result.messages.find((m) => m.toolCallId === 'call_refund')?.content as string)).toEqual({ refunded: 5, for: 'u-1' });
  });

  it('the lead\'s output guardrails check the target\'s reply', async () => {
    const { triage } = setup([toBilling()], ['Your card is 4111 1111 1111 1111.'], {
      triage: { guardrails: { output: [{ name: 'no-cards', check: ({ text }: { text: string }) => (/\d{4} \d{4}/.test(text) ? { ok: false, reason: 'card number' } : { ok: true }) }] } },
    });
    const result = await triage.send('What card?');
    expect(result.finishReason).toBe('guardrail');
    expect(result.guardrail?.name).toBe('no-cards');
  });

  it('a target does not inherit approvals the source remembered with once()', async () => {
    const approved = vi.fn(async () => 'ok');
    const lead = defineTool({ name: 'refund', description: 'Lead refund', input: z.object({}), needsApproval: once(), execute: approved });
    const targetRefund = vi.fn(async () => 'target ok');
    const billing = createAgent({
      name: 'billing',
      description: 'Billing',
      provider: mockModel([{ toolCalls: [{ name: 'refund', args: {}, id: 'call_target_refund' }] }]),
      tools: [defineTool({ name: 'refund', description: 'Target refund', input: z.object({}), needsApproval: once(), execute: targetRefund })],
    });
    const triage = createAgent({
      name: 'triage',
      provider: mockModel([{ toolCalls: [{ name: 'refund', args: {}, id: 'call_lead_refund' }] }, toBilling()]),
      tools: [lead],
      handoffs: [billing],
    });

    const first = await triage.send('Refund me');
    expect(first.finishReason).toBe('awaiting-approval');
    const second = await triage.approvals.resolve({ id: first.approvalId!, approved: true });

    // The target's own `once()` tool asks again: the lead's approval is not in its transcript.
    expect(second.finishReason).toBe('awaiting-approval');
    expect(second.agentName).toBe('billing');
    expect(targetRefund).not.toHaveBeenCalled();
    expect(second.messages.some((m) => m.metadata?.approval !== undefined)).toBe(false);
  });
});

describe('handoffs (N6): sessions', () => {
  it('after a handoff, the next session.send() runs the target', async () => {
    const { triage, triageModel, billingModel } = setup([toBilling()], ['Refund issued.', 'You are welcome.']);
    const session = triage.session();

    await session.send('I was charged twice');
    const second = await session.send('Thanks!');

    expect(second.agentName).toBe('billing');
    expect(second.text).toBe('You are welcome.');
    expect(triageModel.calls).toHaveLength(1);
    expect(billingModel.calls).toHaveLength(2);
    expect(systemPrompts(billingModel.calls[1].messages as Message[])).toEqual(['You handle billing.']);
    expect(toolNames(billingModel, 1)).toEqual(['refund']);
  });

  it('a hand-back works: the target hands back and the lead takes the next turn', async () => {
    const billingHandoffs: Handoff[] = [];
    const billingModel = mockModel(['Refund issued.', { toolCalls: [{ name: 'transfer_to_triage', args: {}, id: 'call_back' }] }]);
    const billing = createAgent({ name: 'billing', description: 'Billing', instructions: 'You handle billing.', provider: billingModel, handoffs: billingHandoffs });
    const triageModel = mockModel([toBilling(), 'Reset it under Settings > Password.', 'Anything else?']);
    const triage = createAgent({ name: 'triage', description: 'Routes the user', instructions: 'You route the user.', provider: triageModel, handoffs: [billing] });
    billingHandoffs.push(handoff(triage));
    const session = triage.session();

    await session.send('I was charged twice');
    const second = await session.send('How do I reset my password?');
    const third = await session.send('Thanks');

    expect(second.agentName).toBe('triage');
    expect(second.text).toBe('Reset it under Settings > Password.');
    expect(toolNames(billingModel, 1)).toEqual(['transfer_to_triage']);
    expect(third.agentName).toBe('triage');
    expect(triageModel.calls).toHaveLength(3);
    expect(systemPrompts(triageModel.calls[1].messages as Message[])).toEqual(['You route the user.']);
  });

  it('agent.send() without a session always starts at the lead', async () => {
    const { triage, triageModel } = setup([toBilling(), 'Lead again.'], ['Billing.']);
    const first = await triage.send('I was charged twice');
    const second = await triage.send(first.messages.filter((m) => m.role !== 'system').concat({ role: 'user', content: 'More' }));
    expect(second.agentName).toBe('triage');
    expect(triageModel.calls).toHaveLength(2);
  });
});

describe('handoffs (N6): approvals and durable resume', () => {
  it('a target tool that needs approval pauses; approvals.resolve() continues in the target, with no drift warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const events: AgentEvent[] = [];
    const callRefund = { toolCalls: [{ name: 'refund', args: { amount: 5 }, id: 'call_refund' }] };
    const refund = refundTool({ needsApproval: true });
    const { triage, billingModel, triageModel } = setup([toBilling()], [callRefund, 'Refunded 5.'], { refund, triage: { onEvent: (event: AgentEvent) => events.push(event) } });

    const paused = await triage.send('Refund me');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.agentName).toBe('billing');

    const result = await triage.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(refund.execute).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Refunded 5.');
    expect(result.agentName).toBe('billing');
    expect(triageModel.calls).toHaveLength(1);
    expect(billingModel.calls).toHaveLength(2);
    expect(toolNames(billingModel, 1)).toEqual(['refund']);
    expect(events.some((event) => event.type === 'agent.drift')).toBe(false);
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/drift|changed/i);
  });

  it('a handoff call next to a call that needs approval hands off once the approval is decided', async () => {
    const approveMe = vi.fn(async () => 'looked up');
    const turn = { toolCalls: [{ name: 'check', args: {}, id: 'call_check' }, { name: 'transfer_to_billing', args: {}, id: 'call_handoff' }] };
    const billingModel = mockModel(['Billing here.']);
    const billing = createAgent({ name: 'billing', description: 'Billing', instructions: 'You handle billing.', provider: billingModel });
    const triage = createAgent({
      name: 'triage',
      provider: mockModel([turn]),
      tools: [defineTool({ name: 'check', description: 'Check', input: z.object({}), needsApproval: true, execute: approveMe })],
      handoffs: [billing],
    });

    const paused = await triage.send('Help');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.agentName).toBe('triage');
    expect(paused.messages.some((m) => m.metadata?.handoff)).toBe(false);

    const result = await triage.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(approveMe).toHaveBeenCalledTimes(1);
    expect(result.agentName).toBe('billing');
    expect(result.text).toBe('Billing here.');
    expect(result.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['call_check', 'call_handoff']);
  });

  it('a crash after the handoff resumes in the target from the checkpoint (agent.resume), with no drift warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = memoryStore();
    const callRefund = { toolCalls: [{ name: 'refund', args: { amount: 5 }, id: 'call_refund' }] };
    const crashing = setup([toBilling()], [callRefund], { refund: refundTool({ crash: { once: true } }), triage: { store }, billing: { store } });
    await expect(crashing.triage.send('Refund me', { sessionId: 'job-1' })).rejects.toThrow('process died');

    // A new process: the same agents, created again, on the same store.
    const events: AgentEvent[] = [];
    const restarted = setup([], ['Refunded 5.'], { triage: { store, onEvent: (event: AgentEvent) => events.push(event) }, billing: { store } });
    const result = await restarted.triage.resume('job-1');

    expect(result?.text).toBe('Refunded 5.');
    expect(result?.agentName).toBe('billing');
    expect(restarted.refund.execute).toHaveBeenCalledTimes(1);
    expect(restarted.triageModel.calls).toHaveLength(0);
    expect(restarted.billingModel.calls).toHaveLength(1);
    expect(systemPrompts(restarted.billingModel.calls[0].messages as Message[])).toEqual(['You handle billing.']);
    expect(events.some((event) => event.type === 'agent.drift')).toBe(false);
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/drift|changed/i);
  });

  it('the drift check on resume compares with the target: a changed target is refused under onAgentDrift: error', async () => {
    const store = memoryStore();
    const callRefund = { toolCalls: [{ name: 'refund', args: { amount: 5 }, id: 'call_refund' }] };
    const crashing = setup([toBilling()], [callRefund], { refund: refundTool({ crash: { once: true } }), triage: { store }, billing: { store } });
    await expect(crashing.triage.send('Refund me', { sessionId: 'job-2' })).rejects.toThrow('process died');

    // The lead is unchanged; the target's instructions changed since the crash.
    const restarted = setup([], ['unused'], { triage: { store, onAgentDrift: 'error' }, billing: { store, instructions: 'You handle billing, politely.' } });
    await expect(restarted.triage.resume('job-2')).rejects.toMatchObject({ code: 'LOUSHO_AGENT_DRIFT' });
    expect(restarted.refund.execute).not.toHaveBeenCalled();
  });

  it('a crashed session turn after a handoff resumes in the target (session.resume)', async () => {
    const store = memoryStore();
    const callRefund = { toolCalls: [{ name: 'refund', args: { amount: 5 }, id: 'call_refund' }] };
    const crashing = setup([toBilling()], [callRefund], { refund: refundTool({ crash: { once: true } }), triage: { store }, billing: { store } });
    await expect(crashing.triage.session({ id: 'chat' }).send('Refund me')).rejects.toThrow('process died');

    const restarted = setup([], ['Refunded 5.', 'Bye.'], { triage: { store }, billing: { store } });
    const session = restarted.triage.session({ id: 'chat' });
    const resumed = await session.resume();
    const next = await session.send('Thanks');

    expect(resumed?.agentName).toBe('billing');
    expect(next.agentName).toBe('billing');
    expect(restarted.triageModel.calls).toHaveLength(0);
  });
});

describe('handoffs (N6): configuration errors', () => {
  const provider = () => mockModel([]);

  it('a target without a name or a description', () => {
    const unnamed = createAgent({ description: 'No name', provider: provider() });
    expect(() => createAgent({ provider: provider(), handoffs: [unnamed] })).toThrow(/needs a name/);
    const undescribed = createAgent({ name: 'billing', provider: provider() });
    expect(() => createAgent({ provider: provider(), handoffs: [undescribed] })).toThrow(/needs a description/);
    // A description given on the handoff is enough.
    expect(() => createAgent({ provider: provider(), handoffs: [handoff(undescribed, { description: 'Billing' })] })).not.toThrow();
  });

  it('duplicate names, a clash with a tool, a remote agent, the agent itself', () => {
    const a = createAgent({ name: 'billing', description: 'A', provider: provider() });
    const b = createAgent({ name: 'billing', description: 'B', provider: provider() });
    expect(() => createAgent({ provider: provider(), handoffs: [a, b] })).toThrow(/two handoff targets are named 'billing'/);
    const clashing = defineTool({ name: 'transfer_to_billing', description: 'x', input: z.object({}), execute: async () => 'x' });
    expect(() => createAgent({ provider: provider(), tools: [clashing], handoffs: [a] })).toThrow(/has the name of one of the agent's tools/);
    const remote = remoteAgent({ url: 'https://agents.example.com/billing', description: 'Remote billing' });
    expect(() => createAgent({ provider: provider(), handoffs: [remote as unknown as SimpleAgent] })).toThrow(/remote agent/);
    expect(() => createAgent({ name: 'billing', provider: provider(), handoffs: [a] })).toThrow(/cannot hand off to itself/);
    expect(() => createAgent({ provider: provider(), maxHandoffs: -1 })).toThrow(/maxHandoffs/);
  });

  it('a clash with a tool from a per-run tools function is refused when the run starts', async () => {
    const billing = createAgent({ name: 'billing', description: 'Billing', provider: provider() });
    const clashing = defineTool({ name: 'transfer_to_billing', description: 'x', input: z.object({}), execute: async () => 'x' });
    const triage = createAgent({ provider: mockModel(['unused']), tools: () => [clashing], handoffs: [billing] });
    await expect(triage.send('Hi')).rejects.toThrow(/uses the tool name 'transfer_to_billing'/);
  });
});
