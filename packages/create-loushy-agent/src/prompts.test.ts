import { describe, it, expect } from 'vitest';
import prompts from 'prompts';
import { collectAnswers, validateAnswers } from './prompts';

describe('collectAnswers', () => {
  it('collects a name/provider/tools answer set via injected (non-interactive) answers', async () => {
    prompts.inject(['my-agent', 'anthropic', ['http', 'github']]);

    const answers = await collectAnswers();

    expect(answers).toEqual({
      name: 'my-agent',
      provider: 'anthropic',
      tools: ['http', 'github'],
    });
  });
});

describe('validateAnswers', () => {
  it('throws naming the invalid provider and the allowed set', () => {
    expect(() =>
      validateAnswers({ name: 'x', provider: 'not-a-provider', tools: [] })
    ).toThrow(/invalid provider 'not-a-provider'.*openai, anthropic, ollama/);
  });

  it('accepts a valid provider', () => {
    const result = validateAnswers({ name: 'x', provider: 'openai', tools: [] });
    expect(result.provider).toBe('openai');
  });
});
