import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../tools/defineTool';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { GenerateOptions, LLMProvider } from '../providers';
import { AgentExecutor } from './AgentExecutor';
import { AgentBuilder } from '../core';
import { mergeModelSettings } from './modelSettings';

const SETTING_KEYS = ['temperature', 'maxTokens', 'topP', 'frequencyPenalty', 'presencePenalty', 'stop', 'seed'];
const sentSettings = (request: object) => SETTING_KEYS.filter((key) => key in request);

describe('mergeModelSettings (C6)', () => {
  it('merges layers key by key and leaves undefined keys out', () => {
    const merged = mergeModelSettings({ temperature: 0.5, maxTokens: 100 }, undefined, { maxTokens: 20, topP: undefined });
    expect(merged).toEqual({ temperature: 0.5, maxTokens: 20 });
    expect(Object.keys(merged)).toEqual(['temperature', 'maxTokens']);
  });
});

describe('createAgent modelSettings (C6, log F16, coding-local F11)', () => {
  it('sends no sampling keys at all when none is set', async () => {
    const model = mockModel(['Hi.']);
    await createAgent({ provider: model }).send('Hello');

    expect(sentSettings(model.calls[0])).toEqual([]);
  });

  it("does not override a wrapping provider's injected maxTokens with an undefined one", async () => {
    const model = mockModel(['Hi.']);
    const capped: LLMProvider = { ...model, generate: (options: GenerateOptions) => model.generate({ maxTokens: 2500, ...options }) };
    await createAgent({ provider: capped }).send('Hello');

    expect(model.calls[0].maxTokens).toBe(2500);
  });

  it("sends the agent's settings on every call, a call's own merged over them", async () => {
    const model = mockModel([{ toolCalls: [{ name: 'echo', args: {} }] }, 'one', 'two'], { onExhausted: 'repeat-last' });
    const agent = createAgent({
      provider: model,
      tools: [defineTool({ name: 'echo', description: 'Echo', input: z.object({}), execute: async () => 'ok' })],
      modelSettings: { maxTokens: 1024, temperature: 0.2, stop: ['END'] },
    });

    await agent.send('Hello');
    await agent.send('Again', { modelSettings: { temperature: 0, seed: 7 } });
    await agent.stream('Streamed', { modelSettings: { maxTokens: 64 } }).result;

    expect(model.calls.map((call) => ({ maxTokens: call.maxTokens, temperature: call.temperature, stop: call.stop, seed: call.seed }))).toEqual([
      { maxTokens: 1024, temperature: 0.2, stop: ['END'], seed: undefined },
      { maxTokens: 1024, temperature: 0.2, stop: ['END'], seed: undefined },
      { maxTokens: 1024, temperature: 0, stop: ['END'], seed: 7 },
      { maxTokens: 64, temperature: 0.2, stop: ['END'], seed: undefined },
    ]);
  });

  it("a sub-agent uses its own settings, not the lead's", async () => {
    const childModel = mockModel(['found']);
    const researcher = createAgent({ name: 'researcher', description: 'Researches', provider: childModel, modelSettings: { maxTokens: 300 } });
    const leadModel = mockModel([{ toolCalls: [{ name: 'task', args: { agent: 'researcher', prompt: 'look', description: 'look' } }] }, 'done']);
    const lead = createAgent({ provider: leadModel, subagents: { researcher }, modelSettings: { maxTokens: 50, temperature: 0.9 } });

    await lead.send('research');

    expect(leadModel.calls.map((call) => call.maxTokens)).toEqual([50, 50]);
    expect(childModel.calls[0].maxTokens).toBe(300);
    expect(sentSettings(childModel.calls[0])).toEqual(['maxTokens']);
  });

  it("a handoff target runs with its own settings", async () => {
    const billingModel = mockModel(['Billing here.']);
    const billing = createAgent({ name: 'billing', description: 'Billing', provider: billingModel, modelSettings: { temperature: 0.1 } });
    const triageModel = mockModel([{ toolCalls: [{ name: 'transfer_to_billing', args: {}, id: 'call_handoff' }] }]);
    const triage = createAgent({ name: 'triage', provider: triageModel, handoffs: [billing], modelSettings: { maxTokens: 10 } });

    await triage.send('Help');

    expect(triageModel.calls[0].maxTokens).toBe(10);
    expect(billingModel.calls[0].temperature).toBe(0.1);
    expect(sentSettings(billingModel.calls[0])).toEqual(['temperature']);
  });
});

describe('AgentExecutor modelSettings (C6)', () => {
  it('the run-level temperature / maxTokens win over modelSettings', async () => {
    const model = mockModel(['Hi.']);
    await AgentExecutor.execute({
      agent: AgentBuilder.create().setName('a').setPrompt('p').build(),
      provider: model,
      input: [{ role: 'user', content: 'Hello' }],
      modelSettings: { maxTokens: 100, topP: 0.5 },
      maxTokens: 10,
    });

    expect(model.calls[0]).toMatchObject({ maxTokens: 10, topP: 0.5 });
    expect(sentSettings(model.calls[0])).toEqual(['maxTokens', 'topP']);
  });
});
