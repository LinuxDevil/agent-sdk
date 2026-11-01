import { describe, expect, it } from 'vitest';
import { listModels } from './catalog';
import { listRegisteredModels, registerModel } from './registry';

const byId = (id: string) => listModels({ env: {} }).find((entry) => entry.id === id);

describe('listModels', () => {
  it('lists every registered model once, with id "<provider>/<modelId>"', () => {
    const entries = listModels({ env: {} });
    expect(entries.length).toBe(listRegisteredModels().length);
    for (const entry of entries) {
      expect(entry.id).toBe(`${entry.provider}/${entry.modelId}`);
    }
  });

  it('is sorted by provider, then model id', () => {
    const entries = listModels({ env: {} });
    const sorted = [...entries].sort(
      (a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) || (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0)
    );
    expect(entries.map((entry) => entry.id)).toEqual(sorted.map((entry) => entry.id));
  });

  it('reports anthropic/claude-sonnet-5-5 with its capabilities, context window and price', () => {
    expect(byId('anthropic/claude-sonnet-5-5')).toMatchObject({
      provider: 'anthropic',
      modelId: 'claude-sonnet-5-5',
      contextWindow: 1000000,
      inputCostPerMTok: 2,
      capabilities: {
        tools: true,
        vision: true,
        reasoning: true,
        structuredOutput: true,
        hostedTools: ['web_search', 'code_interpreter'],
      },
    });
  });

  it('flags reasoning per model family and vision overrides per model', () => {
    expect(byId('openai/gpt-4o-mini')?.capabilities.reasoning).toBe(false);
    expect(byId('openai/o3')?.capabilities.reasoning).toBe(true);
    expect(byId('openai/o3-mini')?.capabilities.vision).toBe(false);
  });

  it('marks ollama models available without a key and applies model overrides', () => {
    const llama = byId('ollama/llama3');
    expect(llama?.capabilities.tools).toBe(false);
    expect(llama?.available).toBe(true);
  });

  it('marks a model available only when its provider key is set in the given env', () => {
    const entries = listModels({ env: { ANTHROPIC_API_KEY: 'x' } });
    for (const entry of entries) {
      if (entry.provider === 'anthropic') expect(entry.available).toBe(true);
      if (entry.provider === 'openai') expect(entry.available).toBe(false);
    }
  });

  it('includes models registered later, with their provider defaults', () => {
    registerModel({ id: 'test-catalog-model', provider: 'ollama', contextWindow: 8192 });
    expect(byId('ollama/test-catalog-model')).toMatchObject({
      contextWindow: 8192,
      capabilities: { tools: true, vision: false, structuredOutput: true },
    });
  });

  it('returns an empty list for an unknown provider filter', () => {
    expect(listModels({ provider: 'nope', env: {} })).toEqual([]);
  });

  it('includes anthropic/claude-haiku-5-5', () => {
    expect(byId('anthropic/claude-haiku-5-5')).toMatchObject({ provider: 'anthropic', modelId: 'claude-haiku-5-5' });
  });
});
