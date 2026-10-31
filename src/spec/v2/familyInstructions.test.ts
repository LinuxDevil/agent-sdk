import { describe, it, expect } from 'vitest';
import { familyInstructions } from './familyInstructions';

describe('familyInstructions', () => {
  it('appends the tail of the key the model id contains', () => {
    expect(familyInstructions('Base.', { anthropic: 'Anthropic tail.' }, 'anthropic/claude-sonnet-5-5')).toBe(
      'Base.\nAnthropic tail.'
    );
  });

  it('returns the base unchanged when no key matches (or there is no map)', () => {
    expect(familyInstructions('Base.', { openai: 'OpenAI tail.' }, 'anthropic/claude-sonnet-5-5')).toBe('Base.');
    expect(familyInstructions('Base.', undefined, 'anthropic/claude-sonnet-5-5')).toBe('Base.');
    expect(familyInstructions('Base.', {}, 'anthropic/claude-sonnet-5-5')).toBe('Base.');
  });

  it('matches anywhere in the model id, not just the provider part', () => {
    expect(familyInstructions('Base.', { claude: 'Claude tail.' }, 'openrouter/anthropic/claude-sonnet-4-5')).toBe(
      'Base.\nClaude tail.'
    );
  });

  it('lets the first matching key in insertion order win', () => {
    expect(
      familyInstructions('Base.', { claude: 'Claude tail.', anthropic: 'Anthropic tail.' }, 'anthropic/claude-sonnet-4-5')
    ).toBe('Base.\nClaude tail.');
  });
});
