import { describe, it, expect } from 'vitest';
import prompts from 'prompts';
import { askMissing } from './prompts';

const defaults = { dir: 'my-agent', provider: 'openai', template: 'minimal' };

describe('askMissing', () => {
  it('asks every question when nothing is known (injected, non-interactive answers)', async () => {
    prompts.inject(['demo', 'anthropic', 'tools']);
    expect(await askMissing({ known: {}, defaults })).toEqual({
      dir: 'demo',
      provider: 'anthropic',
      template: 'tools',
    });
  });

  it('only asks for what the flags did not provide', async () => {
    prompts.inject(['ollama']);
    expect(await askMissing({ known: { dir: 'given', template: 'yaml' }, defaults })).toEqual({
      dir: 'given',
      provider: 'ollama',
      template: 'yaml',
    });
  });

  it('asks nothing when every answer is known', async () => {
    const known = { dir: 'a', provider: 'openrouter', template: 'minimal' };
    expect(await askMissing({ known, defaults })).toEqual(known);
  });

  it('rejects when the user cancels (Ctrl+C)', async () => {
    prompts.inject([new Error('cancel')]);
    await expect(askMissing({ known: {}, defaults })).rejects.toThrow('cancelled');
  });
});
