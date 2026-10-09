import { describe, it, expectTypeOf } from 'vitest';
import { createAgent, type CreateAgentBase, type CreateAgentConfig, type SendOptions } from './createAgent';
import type { ModelSettings } from './providers/llm';
import { createMockProvider } from './providers/mock';

const provider = createMockProvider();

describe('createAgent modelSettings types (C6)', () => {
  it('accepts modelSettings on the agent and on a call', () => {
    const agent = createAgent({ provider, modelSettings: { maxTokens: 1024, temperature: 0.2, topP: 0.9, stop: ['END'], seed: 7 } });
    void agent.send('hi', { modelSettings: { maxTokens: 64 } });
    void agent.stream('hi', { modelSettings: { temperature: 0 } });
    expectTypeOf<SendOptions['modelSettings']>().toEqualTypeOf<ModelSettings | undefined>();
    expectTypeOf<CreateAgentConfig['modelSettings']>().toEqualTypeOf<ModelSettings | undefined>();
  });

  it('rejects unknown settings and wrong value types', () => {
    // Type-only: never called.
    void (() => {
      // @ts-expect-error - not a model setting
      createAgent({ provider, modelSettings: { maxOutputTokens: 10 } });
      // @ts-expect-error - maxTokens is a number
      createAgent({ provider, modelSettings: { maxTokens: '10' } });
    });
  });
});

describe('composing createAgent configs (log F18)', () => {
  it('spreads a shared CreateAgentBase into createAgent()', () => {
    const shared: CreateAgentBase = { maxSteps: 8, modelSettings: { maxTokens: 512 } };
    // Type-only: never called (a model string needs OPENAI_API_KEY at createAgent()).
    void (() => createAgent({ ...shared, model: 'openai/gpt-4o-mini', instructions: 'Be brief.' }));
    createAgent({ ...shared, provider, prompt: 'Be brief.' });
  });

  it('spreads caller overrides typed Partial<CreateAgentBase> after the model and instructions', () => {
    const triage = (overrides: Partial<CreateAgentBase> = {}) =>
      createAgent({ provider, instructions: 'Triage.', maxSteps: 14, ...overrides });
    triage({ maxSteps: 4, modelSettings: { temperature: 0 } });
  });

  it('rejects a Partial<CreateAgentConfig> there: it could carry `prompt` beside `instructions`', () => {
    // Type-only: never called.
    void ((overrides: Partial<CreateAgentConfig>) => {
      // @ts-expect-error - the union keeps `instructions` and `prompt` exclusive
      createAgent({ provider, instructions: 'Triage.', ...overrides });
    });
  });
});
